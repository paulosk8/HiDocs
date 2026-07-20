import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  protocol,
  screen,
  shell
} from 'electron'
import { TargetViewport } from './viewport'
import { RecorderEngine } from './engine/recorder'
import {
  SHOT_PROTOCOL,
  type RecordedStep,
  type SavePayload,
  type ViewportBounds
} from '../shared/ipc-contract'
import { DEFAULT_VIEWPORT, type EngineState } from '../shared/types'
import { saveSession } from './storage'
import { inspectRepo, listBranches, listCommits } from './git'
import { listProjects, forgetProject } from './projects'

/**
 * El puerto de depuración remota debe quedar fijado ANTES de `app.whenReady`:
 * es lo que permite que Playwright se adjunte al viewport vía CDP (§2).
 */
export const REMOTE_DEBUGGING_PORT = 9333
app.commandLine.appendSwitch('remote-debugging-port', String(REMOTE_DEBUGGING_PORT))

// Debe declararse antes de `whenReady` para que el renderer pueda usar
// `docshot:` en `<img src>` bajo su Content-Security-Policy.
protocol.registerSchemesAsPrivileged([
  { scheme: SHOT_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

/** Ancho mínimo del panel de pasos (§8). */
const PANEL_MIN_WIDTH = 440

let mainWindow: BrowserWindow | null = null
const viewport = new TargetViewport()

const engine = new RecorderEngine(REMOTE_DEBUGGING_PORT, app.getPath('temp'), {
  onState: (state: EngineState) => mainWindow?.webContents.send('engine:state', state),
  onStep: (step: RecordedStep) => mainWindow?.webContents.send('recorder:step', step),
  onLog: (level, message) => {
    console[level === 'error' ? 'error' : 'log'](`[engine] ${message}`)
    mainWindow?.webContents.send('engine:log', { level, message })
  }
})

/**
 * Las capturas viven en un directorio temporal fuera del proyecto, así que el
 * renderer no puede cargarlas por `file://` desde su propio origen. Un protocolo
 * propio las sirve sin abrir el sistema de archivos entero: solo se aceptan
 * rutas dentro del directorio temporal de la sesión.
 */
function registerShotProtocol(): void {
  protocol.handle(SHOT_PROTOCOL, async (request) => {
    const encoded = new URL(request.url).pathname.replace(/^\//, '')
    const filePath = decodeURIComponent(encoded)
    const tempRoot = app.getPath('temp')
    if (!filePath.startsWith(tempRoot) || filePath.includes('..')) {
      return new Response('Ruta no permitida', { status: 403 })
    }
    try {
      const data = await readFile(filePath)
      return new Response(data, { headers: { 'Content-Type': 'image/png' } })
    } catch {
      return new Response('No encontrado', { status: 404 })
    }
  })
}

function createWindow(): void {
  // La ventana se dimensiona para que el viewport quepa a tamaño nominal
  // (1440x900) junto al panel; si la pantalla no da, se reduce y la sesión
  // registrará el tamaño real.
  const work = screen.getPrimaryDisplay().workAreaSize
  const desiredWidth = DEFAULT_VIEWPORT.width + PANEL_MIN_WIDTH
  const desiredHeight = DEFAULT_VIEWPORT.height + 96

  mainWindow = new BrowserWindow({
    width: Math.min(desiredWidth, work.width),
    height: Math.min(desiredHeight, work.height),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#f6f7f9',
    title: 'DocRecorder',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  viewport.attachTo(mainWindow)

  const wc = viewport.webContents
  if (wc) {
    // La URL es solo metadato (§5): se refleja en la barra, nunca delimita pasos.
    const onNav = (): void => {
      mainWindow?.webContents.send('engine:state', engine.state)
    }
    wc.on('did-navigate', onNav)
    wc.on('did-navigate-in-page', onNav)
    wc.on('did-finish-load', onNav)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc(): void {
  ipcMain.handle('viewport:navigate', async (_e, url: string) => {
    try {
      await viewport.navigate(url)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      engine.log('error', `No se pudo abrir ${url}: ${message}`)
    }
    // El motor se adjunta en cuanto hay una página real cargada: antes de eso
    // el target CDP existe pero no aporta nada.
    const wc = viewport.webContents
    if (wc) await engine.attach(wc)
    return engine.state
  })

  ipcMain.handle('viewport:set-bounds', (_e, bounds: ViewportBounds) => {
    viewport.setBounds(bounds)
  })

  ipcMain.handle('viewport:set-visible', (_e, visible: boolean) => {
    viewport.setVisible(visible)
  })

  ipcMain.handle('viewport:back', () => viewport.goBack())
  ipcMain.handle('viewport:forward', () => viewport.goForward())
  ipcMain.handle('viewport:reload', () => viewport.reload())

  ipcMain.handle('engine:get-state', () => engine.state)

  ipcMain.handle('recorder:start', async () => {
    const wc = viewport.webContents
    if (wc) await engine.attach(wc)
    try {
      await engine.start()
    } catch (err) {
      engine.log('error', err instanceof Error ? err.message : String(err))
    }
    return engine.state
  })

  ipcMain.handle('recorder:pause', async () => {
    await engine.pause()
    return engine.state
  })

  ipcMain.handle('recorder:resume', async () => {
    await engine.resume()
    return engine.state
  })

  ipcMain.handle('recorder:stop', async () => {
    await engine.stop()
    return engine.state
  })

  ipcMain.handle('session:save', async (_e, payload: SavePayload) => {
    const result = await saveSession(payload, viewport.currentSize)
    engine.log('info', `Sesión guardada en ${result.path}`)
    return result
  })

  ipcMain.handle('dialog:pick-output-dir', async () => {
    if (!mainWindow) return null
    // La vista nativa se pinta por encima de cualquier diálogo modal propio,
    // así que se oculta mientras el selector está abierto.
    viewport.setVisible(false)
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Carpeta de salida de la documentación',
        properties: ['openDirectory', 'createDirectory']
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    } finally {
      viewport.setVisible(true)
    }
  })

  ipcMain.handle('shell:open-path', async (_e, path: string) => {
    await shell.openPath(path)
  })

  ipcMain.handle('git:inspect', async (_e, outputDir: string) => {
    // Devuelve null tanto si no hay repositorio como si `git` no está
    // instalado: en ambos casos la GUI simplemente no ofrece la integración.
    return inspectRepo(outputDir).catch(() => null)
  })

  // El explorador es de solo lectura: estos tres canales no escriben nada en el
  // repositorio, así que ante cualquier fallo devuelven vacío en vez de
  // propagar el error. La vista queda sin datos, que es un estado inocuo.
  ipcMain.handle('git:branches', async (_e, repoRoot: string) => {
    return listBranches(repoRoot).catch(() => [])
  })

  ipcMain.handle('git:commits', async (_e, args: { repoRoot: string; branch: string }) => {
    return listCommits(args.repoRoot, args.branch).catch(() => [])
  })

  ipcMain.handle('projects:list', async () => listProjects().catch(() => []))

  ipcMain.handle('projects:forget', async (_e, repoRoot: string) => {
    await forgetProject(repoRoot).catch(() => {})
    return listProjects().catch(() => [])
  })
}

// Dos instancias competirían por el mismo puerto de depuración: la segunda se
// quedaría sin conexión CDP y, por tanto, sin poder grabar nada, sin síntoma
// visible. Mejor impedirlo y traer al frente la ventana existente.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  registerShotProtocol()
  registerIpc()
  createWindow()

  // Atajo global para pausar/reanudar sin volver al panel (§8): el foco suele
  // estar dentro del sistema documentado mientras se graba.
  const registered = globalShortcut.register('CommandOrControl+Shift+R', () => {
    mainWindow?.webContents.send('recorder:toggle-shortcut')
  })
  if (!registered) engine.log('warn', 'No se pudo registrar el atajo Ctrl+Shift+R')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  engine.cleanup()
  void engine.detach()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
