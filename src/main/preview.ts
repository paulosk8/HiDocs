import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { buildDir, detectChecks, killTree, runChecks } from './checks'
import type { CheckProgress, PreviewResult, PreviewStatus } from '../shared/types'

/**
 * Vista previa del sitio compilado (§17).
 *
 * No vale `npm run start`: el buscador local (`@easyops-cn/docusaurus-search-local`
 * y equivalentes) solo indexa en una compilación de producción, así que en el
 * modo de desarrollo la lupa aparece y no encuentra nada. La forma fiel de ver
 * lo publicado es la que usa el usuario a mano: `npm run build && npm run serve`.
 */

interface Running {
  child: ChildProcess
  url: string
  projectRoot: string
}

let current: Running | null = null

export function previewStatus(): PreviewStatus {
  return current ? { running: true, url: current.url } : { running: false }
}

/** Un puerto libre que el sistema nos presta: fijar 3000 chocaría con el suyo. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('sin puerto libre'))))
    })
  })
}

/** Espera a que el servidor acepte conexiones; da igual qué responda. */
async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!current) return false // lo pararon mientras arrancaba
    try {
      // Una respuesta 404 también sirve: el sitio puede tener `baseUrl` propia y
      // no servir nada en la raíz. Lo que se comprueba es que hay alguien ahí.
      await fetch(`http://127.0.0.1:${port}/`)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  return false
}

/** Carpetas que nunca contienen la página de una guía y sí muchísimos archivos. */
const SKIP = new Set(['assets', 'img', 'images', 'search-index', '.git', 'node_modules'])

/**
 * Ruta servida de la guía recién guardada, buscando su `index.html` dentro de
 * `build/`.
 *
 * Se busca en vez de calcularla porque la URL depende de la configuración ajena
 * (`baseUrl`, `routeBasePath`, el prefijo `docs/`), que no vamos a interpretar
 * desde aquí: leer un `docusaurus.config.ts` para adivinarla sería frágil y se
 * rompería en silencio. El sitio ya compilado, en cambio, dice la verdad.
 */
async function findBuiltPage(root: string, segments: string[]): Promise<string | null> {
  const wanted = segments.filter(Boolean)
  if (!wanted.length) return null
  const tail = wanted.join('/')

  const walk = async (dir: string, depth: number): Promise<string | null> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    const here = relative(root, dir).split(sep).join('/')
    if (here.endsWith(tail) && entries.some((e) => e.isFile() && e.name === 'index.html')) {
      return `/${here}/`
    }
    if (depth === 0) return null
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue
      const found = await walk(join(dir, entry.name), depth - 1)
      if (found) return found
    }
    return null
  }

  return walk(root, 6)
}

/**
 * Compila el sitio y lo sirve. Devuelve la dirección de la guía indicada, o la
 * raíz del sitio si esa guía todavía no se ha compilado (nunca se guardó).
 *
 * Si el `build` falla no se sirve nada: se devuelve el resultado de la
 * comprobación, que es exactamente lo que hay que leer para arreglarlo.
 */
export async function startPreview(
  args: { outputDir: string; segments?: string[] },
  onProgress: (progress: CheckProgress) => void
): Promise<PreviewResult> {
  const project = await detectChecks(args.outputDir)
  if (!project) {
    return {
      error:
        'La carpeta de salida no está dentro de un proyecto Docusaurus (no se encontró su docusaurus.config junto a un package.json).'
    }
  }
  if (!project.canServe) {
    return {
      error: `El proyecto ${project.projectRoot} no tiene los scripts «build» y «serve» en su package.json, así que no se puede levantar la vista previa desde aquí.`
    }
  }

  await stopPreview()

  const build = project.checks.filter((c) => c.script === 'build')
  const checks = await runChecks(project.projectRoot, build, onProgress)
  if (!checks.ok) return { checks }

  let port: number
  try {
    port = await freePort()
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }

  const bin = process.env['DOCRECORDER_NPM'] || 'npm'
  const child = spawn(
    bin,
    ['run', 'serve', '--', '--port', String(port), '--host', '127.0.0.1', '--no-open'],
    {
      cwd: project.projectRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, NO_COLOR: '1' }
    }
  )
  const base = `http://127.0.0.1:${port}`
  current = { child, url: base, projectRoot: project.projectRoot }
  // Si el servidor se muere solo (puerto ocupado, error de arranque), el estado
  // debe dejar de decir que hay una vista previa en marcha.
  child.on('close', () => {
    if (current?.child === child) current = null
  })

  if (!(await waitForServer(port, 30_000))) {
    await stopPreview()
    return { error: 'El servidor de la vista previa no respondió en 30 segundos.' }
  }

  const page = await findBuiltPage(buildDir(project.projectRoot), args.segments ?? [])
  const url = base + (page ?? '/')
  if (current) current.url = url
  return { url }
}

/** Para el servidor. Idempotente: pararlo sin nada en marcha no es un error. */
export async function stopPreview(): Promise<void> {
  const running = current
  current = null
  if (!running) return
  killTree(running.child)
  // Un margen para que suelte el puerto antes de que alguien vuelva a arrancar.
  await new Promise((r) => setTimeout(r, 150))
}
