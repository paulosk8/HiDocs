import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { findProjectRoot } from './docusaurus'
import type {
  CheckProgress,
  ChecksResult,
  CheckRun,
  DocCheck,
  ProjectChecks,
  ProjectGuide
} from '../shared/types'

/**
 * Comprobación del sitio de destino (§17).
 *
 * La vista previa del panel enseña cómo QUEDA el MDX, pero no si Docusaurus lo
 * puede compilar: una etiqueta que MDX no acepta, un enlace roto o un componente
 * sin importar no se ven hasta que alguien ejecuta `npm run build` en el
 * repositorio de documentación. Antes, ese alguien era el usuario, un rato
 * después y con el commit ya hecho.
 *
 * Aquí se ejecutan los mismos comandos que él ejecutaría a mano, en el proyecto
 * de destino y con su propio `package.json`: no se asume ninguno, solo se
 * ofrecen los que ese proyecto tenga.
 */

/**
 * Comandos que sabemos interpretar, del más barato al más caro. El orden importa:
 * se ejecutan en secuencia y se para en el primero que falle, así que compilar el
 * sitio entero —lo que tarda— solo ocurre si lo anterior pasó.
 */
const KNOWN_CHECKS: DocCheck[] = [
  {
    script: 'typecheck',
    label: 'Comprobar los tipos',
    detail: 'tsc sobre el proyecto de documentación'
  },
  {
    script: 'lint:docs',
    label: 'Verificar el estilo de las guías',
    detail: 'las reglas de redacción del propio repositorio'
  },
  {
    script: 'build',
    label: 'Compilar el sitio',
    detail: 'lo que de verdad dice si el MDX se publica sin romperse'
  }
]

/** Tope de cada comando. Compilar un sitio grande tarda; colgarse no es opción. */
const CHECK_TIMEOUT_MS = 10 * 60_000

/** Líneas de salida que se conservan de cada comando (las últimas: ahí está el error). */
const OUTPUT_LINES = 200

/**
 * Rutas donde suele estar `npm` cuando la app se abre desde el Finder o el Dock:
 * un proceso lanzado así hereda un `PATH` mínimo, sin `/opt/homebrew/bin` ni el
 * `bin` de la versión de Node del usuario, y `npm` simplemente «no existe».
 */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

function npmEnv(): NodeJS.ProcessEnv {
  const parts = (process.env['PATH'] ?? '').split(':').filter(Boolean)
  for (const p of EXTRA_PATH) if (!parts.includes(p)) parts.push(p)
  // Sin color: la salida se muestra tal cual en un diálogo, y los códigos ANSI
  // ahí son basura ilegible.
  return { ...process.env, PATH: parts.join(':'), NO_COLOR: '1', FORCE_COLOR: '0' }
}

/** Proceso en marcha, para poder cancelarlo desde la GUI. */
let running: ChildProcess | null = null
let canceled = false

export function cancelChecks(): void {
  canceled = true
  killTree(running)
  running = null
}

/**
 * Mata el proceso Y su descendencia. `npm run` es un intermediario: matarlo a él
 * deja vivo el `docusaurus` que lanzó, que es el que ocupa la CPU y el puerto.
 * Por eso se lanza en su propio grupo (`detached`) y se mata el grupo entero.
 */
export function killTree(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // El proceso ya no existe: nada que matar.
    }
  }
}

interface NpmRun {
  code: number
  output: string
  /** el comando no se pudo lanzar siquiera (npm no está en el PATH) */
  spawnError?: string
}

/**
 * Ejecuta `npm run <script>` en el proyecto de destino y devuelve su salida.
 *
 * Se usa `spawn` y no `execFile` para poder ir emitiendo las líneas según salen:
 * compilar tarda minutos y un diálogo sin señales de vida parece colgado.
 */
export function runNpmScript(
  cwd: string,
  script: string,
  extraArgs: string[],
  onLine: (line: string) => void
): Promise<NpmRun> {
  return new Promise((resolve) => {
    const args = ['run', script, ...(extraArgs.length ? ['--', ...extraArgs] : [])]
    // `DOCRECORDER_NPM` permite a la prueba de humo sustituir el ejecutable sin
    // tocar el resto del circuito (se sigue lanzando un proceso real).
    const bin = process.env['DOCRECORDER_NPM'] || 'npm'
    let child: ChildProcess
    try {
      child = spawn(bin, args, {
        cwd,
        env: npmEnv(),
        // Grupo propio: al cancelar se mata también lo que npm haya lanzado.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // En Windows `npm` es un `.cmd` y no se puede ejecutar sin shell.
        shell: process.platform === 'win32'
      })
    } catch (err) {
      resolve({ code: 1, output: '', spawnError: err instanceof Error ? err.message : String(err) })
      return
    }

    running = child
    const lines: string[] = []
    let pending = ''
    let settled = false

    const push = (chunk: string): void => {
      pending += chunk
      const parts = pending.split(/\r?\n/)
      pending = parts.pop() ?? ''
      for (const line of parts) {
        lines.push(line)
        if (lines.length > OUTPUT_LINES) lines.shift()
        if (line.trim()) onLine(line)
      }
    }

    child.stdout?.on('data', (d: Buffer) => push(String(d)))
    child.stderr?.on('data', (d: Buffer) => push(String(d)))

    const timer = setTimeout(() => {
      killTree(child)
      push(`\nEl comando se detuvo por exceder ${CHECK_TIMEOUT_MS / 60_000} minutos.`)
    }, CHECK_TIMEOUT_MS)

    const finish = (result: NpmRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      running = null
      if (pending.trim()) lines.push(pending)
      resolve({ ...result, output: lines.join('\n') })
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        code: 1,
        output: '',
        spawnError:
          err.code === 'ENOENT'
            ? `No se encontró «${bin}». Instala Node.js o abre la app desde una terminal donde «npm --version» funcione.`
            : err.message
      })
    })
    child.on('close', (code) => finish({ code: code ?? 1, output: '' }))
  })
}

/**
 * Un script del proyecto que es una comprobación por convención: `lint…` o
 * `check…`.
 *
 * Los tres nombres conocidos no bastaban. El repositorio de destino real tiene
 * `lint:docs`, `lint:modelo` y `lint:cadena`, y su CI ejecuta los tres: quedarnos
 * con el primero dejaba fuera comprobaciones que bloquean el PR igual, solo que
 * más tarde y en otra pantalla. Aquí se ofrecen todas, y el usuario decide cuáles
 * merecen la pena en cada guardado (§20).
 */
const VERIFY_SCRIPT = /^(?:lint|check)(?:[:_-].+)?$/

/**
 * Lo que ESCRIBE no se ejecuta nunca, aunque se llame `lint`: `lint:fix`,
 * `format` o `write-*` modifican los archivos del repositorio del usuario, y
 * comprobar antes de commitear no puede significar tocarle el trabajo a nadie.
 */
const WRITES = /(?:fix|format|write)/

/**
 * Los comandos de comprobación de un proyecto, en el orden en que se ejecutan:
 * los tipos primero (rápido y global), después las verificaciones propias del
 * repositorio (por nombre, para que el orden no dependa de cómo esté escrito su
 * `package.json`) y compilar el sitio al final, que es lo que tarda minutos.
 */
export function discoverChecks(scripts: Record<string, string>): DocCheck[] {
  const has = (name: string): boolean => typeof scripts[name] === 'string'
  const known = new Map(KNOWN_CHECKS.map((check) => [check.script, check]))
  const extra = Object.keys(scripts)
    .filter((name) => !known.has(name) && VERIFY_SCRIPT.test(name) && !WRITES.test(name))
    .sort()
    .map<DocCheck>((script) => ({
      script,
      label: `Ejecutar «${script}»`,
      detail: 'comprobación propia de este repositorio'
    }))

  return [
    ...(has('typecheck') ? [known.get('typecheck') as DocCheck] : []),
    ...(has('lint:docs') ? [known.get('lint:docs') as DocCheck] : []),
    ...extra,
    ...(has('build') ? [known.get('build') as DocCheck] : [])
  ]
}

/**
 * Qué se puede comprobar en el proyecto que contiene la carpeta de salida.
 *
 * Devuelve `null` si esa carpeta no está dentro de un proyecto Docusaurus con
 * `package.json`: entonces no hay nada que ejecutar y la app no debe inventarse
 * comandos ni estorbar al guardar.
 */
export async function detectChecks(outputDir: string): Promise<ProjectChecks | null> {
  const projectRoot = await findProjectRoot(outputDir)
  if (!projectRoot) return null
  let scripts: Record<string, string>
  try {
    const raw = await readFile(join(projectRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    scripts = parsed.scripts ?? {}
  } catch {
    return null
  }
  return {
    projectRoot,
    checks: discoverChecks(scripts),
    // La vista previa fiel exige compilar: con el buscador local instalado,
    // `npm run start` no lo indexa y buscar ahí no encuentra nada.
    canServe: typeof scripts['serve'] === 'string' && typeof scripts['build'] === 'string'
  }
}

/**
 * Nombres con los que un repositorio de documentación llama a su guía de estilo.
 * Se prueban en este orden y gana el primero que exista: no hay forma de saber
 * cuál es «la buena» si hay dos, y la convención manda.
 */
const GUIDE_FILES = [
  'CONTRIBUTING.md',
  'CONTRIBUTING.mdx',
  'STYLEGUIDE.md',
  'GUIA-DE-ESTILO.md',
  'GUÍA-DE-ESTILO.md',
  'CONVENCIONES.md'
]

/** Tope de lo que se lee: una guía de estilo no ocupa esto ni de lejos. */
const GUIDE_MAX = 400_000

/** Niveles que se suben buscando la guía, contando la raíz del proyecto. */
const GUIDE_LEVELS = 6

/**
 * La guía de estilo del repositorio de destino (§20).
 *
 * Se busca desde la raíz del proyecto Docusaurus hacia arriba, porque el
 * `CONTRIBUTING.md` de un monorepo vive en la raíz del repositorio y el sitio
 * puede estar en un subdirectorio. La subida se para en cuanto encuentra el
 * repositorio (`.git`): más arriba ya no es de este proyecto.
 *
 * Devuelve `null` si el proyecto no tiene ninguna, que es un caso normal y no un
 * error: entonces la ficha lo dice y no inventa reglas que nadie ha escrito.
 */
export async function readProjectGuide(outputDir: string): Promise<ProjectGuide | null> {
  const projectRoot = await findProjectRoot(outputDir)
  if (!projectRoot) return null

  let dir = projectRoot
  for (let level = 0; level < GUIDE_LEVELS; level++) {
    for (const name of GUIDE_FILES) {
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (!info?.isFile()) continue
      const content = await readFile(path, 'utf8').catch(() => null)
      if (content === null) continue
      return content.length > GUIDE_MAX
        ? { path, content: content.slice(0, GUIDE_MAX), truncated: true }
        : { path, content }
    }
    const isRepo = await stat(join(dir, '.git')).then(
      () => true,
      () => false
    )
    const parent = dirname(dir)
    if (isRepo || parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Ejecuta las comprobaciones en orden y se para en la primera que falle: si los
 * tipos no cuadran, compilar el sitio entero solo haría esperar para decir lo
 * mismo.
 */
/**
 * Archivos que cita la salida de un comando, en rutas relativas a la raíz del
 * proyecto. Sirve para responder a la pregunta que se hace quien ve fallar la
 * comprobación: «¿esto lo he roto yo?».
 *
 * No intenta entender el formato de cada herramienta —cada linter escribe el
 * suyo—, solo recoge lo que parece la ruta de un archivo de documentación. Un
 * falso positivo aquí no rompe nada: como mucho, un archivo de más en la lista.
 */
const FILE_PATTERN = /[\w./@-]+\.(?:mdx|md|json|tsx?|jsx?)/g

export function citedFiles(
  output: string,
  projectRoot: string,
  guideDir?: string
): { own: string[]; other: string[] } {
  const guide = guideDir ? relative(projectRoot, guideDir) : ''
  const own = new Set<string>()
  const other = new Set<string>()
  for (const match of output.match(FILE_PATTERN) ?? []) {
    // Las herramientas escriben unas veces la ruta absoluta y otras la relativa
    // al proyecto; se normaliza para poder compararlas con la de la guía.
    const path = (isAbsolute(match) ? relative(projectRoot, match) : match).replace(/^\.\//, '')
    if (path.startsWith('..') || !path.includes('.')) continue
    // `package.json`, `tsconfig.json` y demás no son documentación de nadie: se
    // dejan fuera para no llamar «otras páginas» a la configuración.
    if (!path.includes('/')) continue
    if (guide && (path === guide || path.startsWith(guide + sep) || path.startsWith(guide + '/'))) {
      own.add(path)
    } else {
      other.add(path)
    }
  }
  return { own: [...own], other: [...other] }
}

/**
 * @param guideDir carpeta de la guía que se acaba de escribir, si la tanda viene
 *   de guardar. Con ella, un fallo puede decir si es de la guía o del resto del
 *   sitio; sin ella (comprobación lanzada a mano) se informa igual, sin repartir.
 */
export async function runChecks(
  projectRoot: string,
  checks: DocCheck[],
  onProgress: (progress: CheckProgress) => void,
  guideDir?: string
): Promise<ChecksResult> {
  canceled = false
  const runs: CheckRun[] = []
  for (const [index, check] of checks.entries()) {
    if (canceled) break
    const started = Date.now()
    onProgress({ script: check.script, label: check.label, index, total: checks.length })
    const result = await runNpmScript(projectRoot, check.script, [], (line) =>
      onProgress({ script: check.script, label: check.label, index, total: checks.length, line })
    )
    const run: CheckRun = {
      script: check.script,
      label: check.label,
      ok: result.code === 0 && !result.spawnError,
      ms: Date.now() - started,
      output: result.spawnError ? result.spawnError : result.output
    }
    if (!run.ok && guideDir) {
      const cited = citedFiles(run.output, projectRoot, guideDir)
      if (cited.own.length) run.ownFiles = cited.own
      if (cited.other.length) run.otherFiles = cited.other
    }
    runs.push(run)
    if (!run.ok) {
      // Cancelar mata el proceso, y eso lo devuelve con código distinto de cero:
      // no es un fallo del sitio y no debe leerse como tal.
      return { projectRoot, ok: false, runs, canceled: canceled || undefined }
    }
  }
  return { projectRoot, ok: !canceled, runs, canceled: canceled || undefined }
}

/**
 * Resumen de una tanda para el registro: qué se ejecutó y cuánto tardó.
 * Se escribe en la consola del main, que es donde se mira cuando algo va raro.
 */
export function summarize(result: ChecksResult): string {
  const parts = result.runs.map((r) => `${r.script} ${r.ok ? 'ok' : 'FALLA'} (${r.ms} ms)`)
  return parts.join(' · ') || 'sin comprobaciones'
}

/** La carpeta `build` del proyecto, donde `docusaurus build` deja el sitio. */
export function buildDir(projectRoot: string): string {
  return join(projectRoot, 'build')
}
