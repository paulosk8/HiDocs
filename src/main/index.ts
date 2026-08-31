import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  shell,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { TargetViewport } from './viewport'
import { RecorderEngine } from './engine/recorder'
import {
  SHOT_PROTOCOL,
  type AiDraftRequest,
  type DraftPayload,
  type GroupTarget,
  type RecordedStep,
  type SavePayload,
  type ViewportBounds
} from '../shared/ipc-contract'
import {
  DEFAULT_VIEWPORT,
  type AiProvider,
  type AiSettings,
  type CheckProgress,
  type DocSession,
  type EngineState,
  type RegenReport
} from '../shared/types'
import { DEFAULT_ZOOM } from '../shared/zoom'
import { saveSession } from './storage'
import { captureSourceToFile, listCaptureSources, readClipboard } from './capture'
import {
  commitPendingDoc,
  discardPendingDoc,
  inspectRepo,
  listBranches,
  listCommits,
  readBranchDocs,
  readCommitDocForEdit,
  readCommitDocs,
  readDocImage,
  readPendingDocs
} from './git'
import { listProjects, forgetProject } from './projects'
import { suggestDocsDir } from './docusaurus'
import { cancelChecks, detectChecks, runChecks, summarize } from './checks'
import { previewStatus, startPreview, stopPreview } from './preview'
import { saveDraft, loadDraft, clearDraft } from './draft'
import { aiStatus, setAiKey, setAiSettings } from './settings'
import { draftSteps } from './ai'

/**
 * El puerto de depuración remota debe quedar fijado ANTES de `app.whenReady`:
 * es lo que permite que Playwright se adjunte al viewport vía CDP (§2).
 */
export const REMOTE_DEBUGGING_PORT = 9333
app.commandLine.appendSwitch('remote-debugging-port', String(REMOTE_DEBUGGING_PORT))

// Aísla el estado persistente (borrador, registro de proyectos, preferencias) en
// un `userData` propio cuando se pide por entorno: así las pruebas de humo no
// tocan los datos reales del usuario (su borrador incluido).
if (process.env['DOCRECORDER_USER_DATA']) {
  app.setPath('userData', process.env['DOCRECORDER_USER_DATA'])
}

// Debe declararse antes de `whenReady` para que el renderer pueda usar
// `docshot:` en `<img src>` bajo su Content-Security-Policy.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SHOT_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // El editor de capturas externas carga la imagen con `crossOrigin` para
      // poder recortarla en un `<canvas>` y leer el resultado. Sin habilitar CORS
      // en el esquema, Chromium bloquea esa petición antes de llegar al handler.
      corsEnabled: true
    }
  }
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
    // Se sirven las capturas temporales de la sesión y las del borrador guardado
    // (userData/draft/img), que sobreviven al cierre para restaurar la grabación.
    const tempRoot = app.getPath('temp')
    const draftImg = join(app.getPath('userData'), 'draft', 'img')
    const allowed = filePath.startsWith(tempRoot) || filePath.startsWith(draftImg)
    if (!allowed || filePath.includes('..')) {
      return new Response('Ruta no permitida', { status: 403 })
    }
    try {
      const data = await readFile(filePath)
      return new Response(data, {
        headers: {
          'Content-Type': 'image/png',
          // El editor de capturas externas dibuja la imagen en un `<canvas>` para
          // recortarla: sin esta cabecera el lienzo queda «contaminado» (otro
          // origen) y el navegador prohíbe leer el resultado. Solo se sirven
          // capturas propias de la sesión, así que abrirlo no expone nada.
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch {
      return new Response('No encontrado', { status: 404 })
    }
  })
}

/**
 * Menú contextual de la GUI: correcciones ortográficas y edición.
 *
 * Electron no trae menú contextual propio, así que sin esto el clic derecho no
 * hace nada y las palabras que el corrector subraya no se pueden corregir. Se
 * aplica solo a la ventana de la aplicación, no al visor: ahí el menú es el del
 * sistema documentado y abrirlo encima estorbaría a la grabación.
 */
function attachContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    // Fuera de un campo editable y sin selección no hay nada que ofrecer.
    if (!params.isEditable && !params.selectionText) return

    const items: MenuItemConstructorOptions[] = []

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions) {
        items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) })
      }
      if (!params.dictionarySuggestions.length) {
        items.push({ label: 'Sin sugerencias', enabled: false })
      }
      items.push(
        { type: 'separator' },
        {
          label: `Añadir «${params.misspelledWord}» al diccionario`,
          click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        },
        { type: 'separator' }
      )
    }

    items.push(
      { label: 'Cortar', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copiar', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Pegar', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Seleccionar todo', role: 'selectAll', enabled: params.editFlags.canSelectAll }
    )

    Menu.buildFromTemplate(items).popup({
      window: BrowserWindow.fromWebContents(wc) ?? undefined
    })
  })
}

/**
 * Idiomas del corrector. En macOS lo provee el sistema operativo con su propia
 * lista, y fijarla desde aquí lanza; en el resto se pide español, que es el
 * idioma en el que se escribe la documentación.
 */
function configureSpellChecker(): void {
  if (process.platform === 'darwin') return
  try {
    const available = session.defaultSession.availableSpellCheckerLanguages
    const wanted = ['es-ES', 'es'].filter((lang) => available.includes(lang)).slice(0, 1)
    if (wanted.length) session.defaultSession.setSpellCheckerLanguages(wanted)
  } catch (err) {
    console.warn('[spellcheck] no se pudo fijar el idioma:', err)
  }
}

/**
 * Qué zoom pide esa tecla, ya aplicado, o `null` si no es una tecla de zoom.
 * `=` entra porque en la mayoría de teclados el `+` se escribe con Shift y lo
 * que llega sin él es el `=` de la misma tecla.
 */
function zoomFromKey(key: string): number | null {
  if (key === '+' || key === '=') return viewport.stepZoom('in')
  if (key === '-' || key === '_') return viewport.stepZoom('out')
  if (key === '0') return viewport.setZoom(DEFAULT_ZOOM)
  return null
}

/** Avisa a la GUI del zoom que quedó, para que el porcentaje lo siga. */
function sendZoom(factor: number): void {
  mainWindow?.webContents.send('viewport:zoom-changed', factor)
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
      sandbox: false,
      // Los títulos y descripciones de los pasos son prosa que acaba publicada
      // en el manual: merece corrector.
      spellcheck: true
    }
  })

  attachContextMenu(mainWindow.webContents)

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

    // Zoom del visor con el teclado (§19). Chromium ya trae ⌘+/⌘−/⌘0, pero
    // cambia la escala por su cuenta y la barra no se entera: se intercepta
    // aquí para que teclado, rueda y botones muevan el MISMO valor y el
    // porcentaje diga siempre la verdad. Solo dentro del visor: con la GUI
    // enfocada, las teclas siguen haciendo lo de siempre.
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.alt) return
      if (!(input.control || input.meta)) return
      const zoomed = zoomFromKey(input.key)
      if (zoomed === null) return
      event.preventDefault()
      sendZoom(zoomed)
    })

    // ⌘/Ctrl + rueda dentro del visor: Chromium aplica su propio salto, así que
    // se rehace con el paso de nuestra escala en vez de dejar dos escalas
    // conviviendo.
    wc.on('zoom-changed', (_event, direction) => {
      sendZoom(viewport.stepZoom(direction === 'in' ? 'in' : 'out'))
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** Progreso de las comprobaciones hacia la GUI (línea a línea, como salen). */
function sendCheckProgress(progress: CheckProgress): void {
  mainWindow?.webContents.send('checks:progress', progress)
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

  ipcMain.handle(
    'viewport:zoom',
    (_e, args: { action: 'in' | 'out' | 'reset' | 'set'; factor?: number }) => {
      if (args.action === 'in' || args.action === 'out') return viewport.stepZoom(args.action)
      if (args.action === 'reset') return viewport.setZoom(DEFAULT_ZOOM)
      return viewport.setZoom(args.factor ?? DEFAULT_ZOOM)
    }
  )

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

  ipcMain.handle(
    'recorder:capture-group',
    async (_e, args: { targets: GroupTarget[]; url?: string }) => {
      return engine.captureGroup(args.targets, args.url)
    }
  )

  ipcMain.handle('session:save', async (_e, payload: SavePayload) => {
    const result = await saveSession(payload, viewport.currentSize, sendCheckProgress)
    engine.log('info', `Sesión guardada en ${result.path}`)
    if (result.checks) {
      engine.log(
        result.checks.ok ? 'info' : 'warn',
        `Comprobación del sitio: ${summarize(result.checks)}`
      )
    }
    return result
  })

  // --- comprobación del sitio de destino y vista previa (§18) ---

  ipcMain.handle('checks:detect', async (_e, outputDir: string) => {
    return detectChecks(outputDir).catch(() => null)
  })

  ipcMain.handle('checks:run', async (_e, outputDir: string) => {
    const project = await detectChecks(outputDir).catch(() => null)
    if (!project || !project.checks.length) return null
    return runChecks(project.projectRoot, project.checks, sendCheckProgress)
  })

  ipcMain.handle('checks:cancel', () => cancelChecks())

  ipcMain.handle('preview:start', async (_e, args: { outputDir: string; segments?: string[] }) => {
    const result = await startPreview(args, sendCheckProgress)
    // Se abre en el navegador del usuario y no en el visor: el visor es el
    // sistema que se está documentando, y perder su sesión abierta para mirar
    // el manual sería un mal cambio. La prueba de humo lo desactiva
    // (`DOCRECORDER_NO_OPEN`): abrir el navegador de quien la ejecuta sobra.
    if (result.url && !process.env['DOCRECORDER_NO_OPEN']) await shell.openExternal(result.url)
    return result
  })

  ipcMain.handle('preview:stop', async () => stopPreview())
  ipcMain.handle('preview:status', () => previewStatus())

  // --- capturas ajenas al visor (§12) ---

  ipcMain.handle('capture:sources', async () => {
    return listCaptureSources().catch((err) => ({
      sources: [],
      error: err instanceof Error ? err.message : String(err)
    }))
  })

  ipcMain.handle('capture:take', async (_e, args: { sourceId: string; hideWindow: boolean }) => {
    const file = join(engine.ensureShotDir(), `externa-${randomUUID()}.png`)
    return captureSourceToFile(args.sourceId, file, args.hideWindow, mainWindow)
  })

  ipcMain.handle('capture:import-file', async () => {
    if (!mainWindow) return { canceled: true }
    // Como en el resto de selectores nativos, la vista del visor se aparta.
    viewport.setVisible(false)
    try {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Imagen que documentar',
        properties: ['openFile'],
        filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
      })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
      // La imagen se copia (no se enlaza): el archivo original puede moverse o
      // borrarse, y el paso debe seguir teniendo su captura.
      const source = picked.filePaths[0]
      const image = nativeImage.createFromPath(source)
      if (image.isEmpty()) return { error: 'No se pudo leer esa imagen.' }
      const file = join(engine.ensureShotDir(), `externa-${randomUUID()}.png`)
      await writeFile(file, image.toPNG())
      return { file }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    } finally {
      viewport.setVisible(true)
    }
  })

  ipcMain.handle('clipboard:read', async () => readClipboard(engine.ensureShotDir()))

  ipcMain.handle('capture:save-edited', async (_e, dataUrl: string) => {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!match) return null
    const file = join(engine.ensureShotDir(), `externa-${randomUUID()}.png`)
    await writeFile(file, Buffer.from(match[1], 'base64'))
    return file
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

  // Solo http/https: el canal existe para abrir la consola del proveedor de IA,
  // no para que el renderer pueda lanzar `file://` ni esquemas del sistema.
  ipcMain.handle('shell:open-external', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })

  ipcMain.handle('git:inspect', async (_e, outputDir: string) => {
    // Devuelve null tanto si no hay repositorio como si `git` no está
    // instalado: en ambos casos la GUI simplemente no ofrece la integración.
    return inspectRepo(outputDir).catch(() => null)
  })

  // La lectura del repositorio es de solo lectura: estos canales no escriben
  // nada, así que ante cualquier fallo devuelven vacío en vez de propagar el
  // error. La vista queda sin datos, que es un estado inocuo.
  ipcMain.handle('git:branches', async (_e, repoRoot: string) => {
    return listBranches(repoRoot).catch(() => [])
  })

  ipcMain.handle('git:commits', async (_e, args: { repoRoot: string; branch: string }) => {
    return listCommits(args.repoRoot, args.branch).catch(() => [])
  })

  ipcMain.handle('git:branch-docs', async (_e, args: { repoRoot: string; branch: string }) => {
    return readBranchDocs(args.repoRoot, args.branch).catch(() => [])
  })

  ipcMain.handle('git:commit-docs', async (_e, args: { repoRoot: string; commit: string }) => {
    return readCommitDocs(args.repoRoot, args.commit).catch(() => [])
  })

  // Las capturas del commit se escriben en la misma carpeta temporal que las
  // grabadas: a partir de ahí el paso es uno más del panel.
  ipcMain.handle(
    'git:commit-doc-edit',
    async (_e, args: { repoRoot: string; commit: string; path: string }) => {
      return readCommitDocForEdit(
        args.repoRoot,
        args.commit,
        args.path,
        engine.ensureShotDir()
      ).catch(() => null)
    }
  )

  ipcMain.handle(
    'git:doc-image',
    async (_e, args: { repoRoot: string; commit: string; imagePath: string }) => {
      return readDocImage(args.repoRoot, args.commit, args.imagePath).catch(() => null)
    }
  )

  ipcMain.handle('git:pending-docs', async (_e, repoRoot: string) => {
    return readPendingDocs(repoRoot).catch(() => [])
  })

  // El error SÍ se propaga: aquí se escribe en el repositorio, y si el commit no
  // sale hay que decir por qué (rama, cambios ajenos), igual que al guardar.
  ipcMain.handle(
    'git:commit-pending',
    async (
      _e,
      args: { repoRoot: string; dir: string; branch: string; message: string; push: boolean }
    ) => {
      return commitPendingDoc(args)
    }
  )

  // Descartar también escribe (borra y revierte): el error se propaga para poder
  // decir qué no se pudo tirar, en vez de dejar creer que se limpió todo.
  ipcMain.handle('git:discard-pending', async (_e, args: { repoRoot: string; dir: string }) => {
    return discardPendingDoc(args)
  })

  ipcMain.handle('projects:list', async () => listProjects().catch(() => []))

  ipcMain.handle('projects:forget', async (_e, repoRoot: string) => {
    await forgetProject(repoRoot).catch(() => {})
    return listProjects().catch(() => [])
  })

  ipcMain.handle('docusaurus:suggest-docs', async (_e, dir: string) => {
    return suggestDocsDir(dir).catch(() => null)
  })

  ipcMain.handle('draft:save', async (_e, draft: DraftPayload) => {
    await saveDraft(draft).catch((err) =>
      engine.log('warn', `No se pudo guardar el borrador: ${err}`)
    )
  })
  ipcMain.handle('draft:load', async () => loadDraft().catch(() => null))
  ipcMain.handle('draft:clear', async () => {
    await clearDraft().catch(() => undefined)
  })

  // La clave de IA no sale nunca del proceso principal: el renderer solo puede
  // guardarla y preguntar si existe.
  ipcMain.handle('ai:status', async () => aiStatus())

  ipcMain.handle('ai:set-key', async (_e, args: { provider: AiProvider; key: string }) => {
    return setAiKey(args.provider, args.key)
  })

  ipcMain.handle('ai:set-settings', async (_e, patch: Partial<AiSettings>) => {
    return setAiSettings(patch)
  })

  ipcMain.handle('ai:draft', async (_e, request: AiDraftRequest) => {
    return draftSteps(request, (progress) => mainWindow?.webContents.send('ai:progress', progress))
  })

  ipcMain.handle('runner:regenerate', async (_e, given?: string): Promise<RegenReport> => {
    if (!mainWindow) return { results: [] }
    let featureDir: string
    if (given) {
      featureDir = given
    } else {
      // Se pide la carpeta; la vista nativa se oculta mientras el selector nativo
      // está abierto (como en la carpeta de salida).
      viewport.setVisible(false)
      try {
        const picked = await dialog.showOpenDialog(mainWindow, {
          title: 'Carpeta de la funcionalidad a regenerar (con su session.json)',
          properties: ['openDirectory']
        })
        if (picked.canceled || !picked.filePaths[0]) return { canceled: true, results: [] }
        featureDir = picked.filePaths[0]
      } finally {
        viewport.setVisible(true)
      }
    }

    try {
      const json = await readFile(join(featureDir, 'session.json'), 'utf8')
      const session = JSON.parse(json) as DocSession
      const results = await engine.regenerate(session, featureDir, (r) =>
        mainWindow?.webContents.send('runner:progress', r)
      )
      return { featureDir, results }
    } catch (err) {
      return {
        error:
          err instanceof Error && /ENOENT/.test(err.message)
            ? 'La carpeta elegida no contiene un session.json.'
            : err instanceof Error
              ? err.message
              : String(err),
        results: []
      }
    }
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
  configureSpellChecker()
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
  // El servidor de la vista previa y cualquier comando en marcha son procesos
  // hijos: sin matarlos aquí sobrevivirían a la app, con su puerto ocupado.
  cancelChecks()
  void stopPreview()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
