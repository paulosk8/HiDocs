import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { relative, isAbsolute, join } from 'node:path'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { shell } from 'electron'
import type { CommitDocEdit, RecordedStep } from '../shared/ipc-contract'
import type {
  BranchDocInfo,
  CommitDocs,
  DiscardResult,
  DocSession,
  GitBranchInfo,
  GitCommitInfo,
  GitCommitOptions,
  GitCommitResult,
  GitRepoInfo,
  PendingDocInfo
} from '../shared/types'
import { validateBranchName } from '../shared/naming'
export { suggestBranchName, suggestCommitMessage, validateBranchName } from '../shared/naming'

const run = promisify(execFile)

/**
 * Integración con el repositorio Docusaurus que mantiene otra persona.
 *
 * Se invoca el `git` del sistema en vez de embeber una implementación: así se
 * respetan la configuración, las credenciales y los hooks que ya tenga esa
 * persona, sin duplicar su gestión de identidades.
 *
 * Todo lo de este módulo escribe en un repositorio ajeno, así que las
 * salvaguardas son parte del contrato, no un extra:
 *
 *  - Solo se indexan las rutas que escribe DocRecorder. Nunca `git add -A`:
 *    barrería trabajo en curso de esa persona hacia nuestro commit.
 *  - No se cambia de rama con el árbol sucio: los cambios ajenos viajarían a la
 *    rama nueva y quedarían mezclados con la documentación.
 *  - No se hace push salvo petición explícita, y nunca con `--force`.
 */

const GIT_TIMEOUT_MS = 20_000

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    // El repositorio de documentación puede ser grande; el diff no se lee aquí,
    // pero conviene no quedarse corto con salidas como `status --porcelain`.
    maxBuffer: 10 * 1024 * 1024
  })
  return stdout
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim()
}

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

/**
 * `dirname` para rutas de Git. Git las devuelve siempre con `/`, también en
 * Windows, donde `path.dirname` esperaría `\`. Devuelve '' en la raíz.
 */
function posixDirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '' : path.slice(0, cut)
}

interface WorkingTreeStatus {
  /** rutas con cambios ya en el índice */
  staged: string[]
  /** rutas seguidas y modificadas en el árbol de trabajo */
  modified: string[]
  /** rutas sin seguimiento */
  untracked: string[]
}

/**
 * Lee `git status` de forma robusta.
 *
 * Tres detalles que hacen falta para no clasificar mal los archivos:
 *
 *  - `-z` evita que Git escape con comillas las rutas con acentos o espacios
 *    (`core.quotePath`), y separa por NUL en vez de por salto de línea.
 *  - `--untracked-files=all` lista los archivos uno a uno. Por defecto Git
 *    colapsa un directorio nuevo entero en una sola entrada (`?? carpeta/`), y
 *    entonces las rutas que escribe DocRecorder no coinciden con esa entrada y
 *    parecerían de otra persona.
 *  - La salida NO se puede recortar: una entrada como `" M archivo"` empieza por
 *    espacio, que es justo lo que indica que el cambio está sin indexar.
 */
async function readStatus(root: string): Promise<WorkingTreeStatus> {
  // `--no-optional-locks`: `git status` refresca el índice y para eso toma
  // `.git/index.lock`. Aquí se está MIRANDO un repositorio ajeno por detrás (la
  // franja de estado lo relee sola), así que tomar ese cerrojo hace fallar el
  // `git add` que el usuario esté ejecutando en su terminal en ese instante. Es
  // la misma bandera que usan los editores para inspeccionar sin estorbar, y va
  // en la línea del principio de §10: no tocamos su repositorio salvo al
  // commitear lo que ha pedido.
  const raw = await gitRaw(root, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all'
  ]).catch(() => '')
  const tokens = raw.split('\0')
  const status: WorkingTreeStatus = { staged: [], modified: [], untracked: [] }

  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (!entry || entry.length < 4) continue
    const index = entry[0]
    const worktree = entry[1]
    const path = entry.slice(3)
    // En renombrados y copias, la ruta original viaja en el token siguiente.
    if (index === 'R' || index === 'C') i++

    if (index === '?') {
      status.untracked.push(path)
      continue
    }
    if (index !== ' ') status.staged.push(path)
    if (worktree !== ' ') status.modified.push(path)
  }
  return status
}

/** `git` puede no estar instalado: la app debe seguir funcionando sin él. */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await run('git', ['--version'], { timeout: GIT_TIMEOUT_MS, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Estado del repositorio que contiene `dir`, o `null` si no hay ninguno.
 *
 * `dir` es la carpeta de salida elegida por el usuario: si está dentro de un
 * repositorio, la integración Git se ofrece sola, sin pedir configuración extra.
 */
export async function inspectRepo(dir: string): Promise<GitRepoInfo | null> {
  if (!dir) return null
  let root: string
  try {
    root = await git(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    return null // no es un repositorio, o `git` no está disponible
  }
  if (!root) return null

  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')

  // Un repositorio recién creado no tiene commits: `HEAD` no resuelve todavía.
  const hasCommits = await git(root, ['rev-parse', '--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false)

  const remoteUrl = await git(root, ['remote', 'get-url', 'origin']).catch(() => '')

  const status = await readStatus(root)

  return {
    root,
    branch,
    hasCommits,
    remoteUrl: remoteUrl || null,
    stagedPaths: status.staged,
    dirtyPaths: status.modified,
    untrackedPaths: status.untracked,
    defaultBranch: hasCommits ? await detectBaseBranch(root) : null
  }
}

/**
 * Rama de la que debe nacer cada rama de documentación, o `null` si no se puede
 * determinar ninguna.
 *
 * Sin esto, `git checkout -b` ramifica desde HEAD: al documentar dos
 * funcionalidades seguidas, la segunda rama nacería de la primera y su PR
 * arrastraría la documentación de la anterior. En GitHub Flow cada rama parte de
 * la rama por defecto.
 *
 * Se prefiere `origin/HEAD` porque es lo que el repositorio declara como su rama
 * por defecto; `main`/`master` son solo el respaldo cuando ese puntero no está
 * configurado localmente (es habitual: solo lo fija `clone`, no `remote add`).
 *
 * Se resuelve siempre contra la copia LOCAL: ramificar desde `origin/main`
 * exigiría un `fetch` con red y credenciales en cada guardado. Si la copia local
 * está desactualizada, la rama nace algo atrasada, pero eso se resuelve solo al
 * rebasar el PR y no bloquea el trabajo sin conexión.
 */
async function detectBaseBranch(root: string): Promise<string | null> {
  const head = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(
    () => ''
  )
  // `origin/HEAD` apunta a `origin/main`; aquí interesa la rama local `main`.
  const preferred = head.replace(/^origin\//, '')

  for (const candidate of [preferred, 'main', 'master']) {
    if (!candidate) continue
    const exists = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])
      .then(() => true)
      .catch(() => false)
    if (exists) return candidate
  }
  return null
}

/**
 * Separador para los formatos `--format` de Git.
 *
 * Se usa un carácter de control (unit separator) en vez de algo como `|` porque
 * un asunto de commit puede contener cualquier carácter imprimible, y entonces
 * la línea se partiría por donde no toca.
 */
const FIELD = '\x1f'

/**
 * Ramas locales del repositorio, para el explorador (solo lectura).
 *
 * Deliberadamente NO se listan las ramas remotas: la app no habla con la red, y
 * mezclar `origin/...` en la lista sugeriría acciones que no existen.
 */
export async function listBranches(root: string): Promise<GitBranchInfo[]> {
  const defaultBranch = await detectBaseBranch(root)
  const raw = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=%(refname:short)${FIELD}%(HEAD)${FIELD}%(contents:subject)${FIELD}%(committerdate:iso8601)`,
    'refs/heads'
  ]).catch(() => '')
  if (!raw) return []

  const branches: GitBranchInfo[] = []
  for (const line of raw.split('\n').filter(Boolean)) {
    const [name, head, subject, date] = line.split(FIELD)
    // `rev-list a..b` cuenta lo que tiene `b` y no `a`: los commits de
    // documentación que esta rama aporta sobre la rama por defecto.
    const ahead =
      defaultBranch && name !== defaultBranch
        ? await git(root, ['rev-list', '--count', `${defaultBranch}..${name}`]).catch(() => '0')
        : '0'
    branches.push({
      name,
      current: head === '*',
      lastCommitSubject: subject ?? '',
      lastCommitDate: date ?? '',
      aheadOfDefault: Number(ahead) || 0
    })
  }
  return branches
}

/**
 * Historial de una rama, del commit más reciente hacia atrás.
 *
 * `limit` acota la lectura porque el repositorio Docusaurus es ajeno y puede
 * tener años de historia que no aportan nada a esta vista.
 */
export async function listCommits(
  root: string,
  branch: string,
  limit = 50
): Promise<GitCommitInfo[]> {
  const invalid = validateBranchName(branch)
  if (invalid) return []
  const raw = await git(root, [
    'log',
    `--max-count=${limit}`,
    `--format=%h${FIELD}%s${FIELD}%an${FIELD}%ad`,
    '--date=iso8601',
    branch,
    // Corta la ambigüedad entre una rama y un archivo que se llamen igual: sin
    // esto Git aborta pidiendo que se desambigüe.
    '--'
  ]).catch(() => '')
  if (!raw) return []

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, date] = line.split(FIELD)
      return { hash, subject: subject ?? '', author: author ?? '', date: date ?? '' }
    })
}

/**
 * Funcionalidades ya documentadas en una rama, de la más reciente a la más
 * antigua. Es lo que permite **retomar una rama**: de aquí salen el módulo, el
 * rol y la URL base con los que se venía trabajando, sin volver a escribirlos.
 *
 * Se recorre el **historial** (`log --name-only`) en vez del árbol (`ls-tree`)
 * porque el historial ya viene ordenado por recencia: con el árbol habría que
 * preguntar la fecha de cada archivo por separado, un proceso `git` por
 * funcionalidad. `limit` acota cuántos `session.json` se llegan a leer, que es
 * lo único que cuesta un proceso por elemento.
 *
 * Solo lectura: no hay checkout ni escritura, igual que el resto del explorador.
 */
export async function readBranchDocs(
  root: string,
  branch: string,
  limit = 12
): Promise<BranchDocInfo[]> {
  if (validateBranchName(branch)) return []
  const raw = await git(root, [
    'log',
    '--max-count=100',
    '--name-only',
    '--format=',
    branch,
    '--',
    // Pathspec con comodín: coincide con `session.json` a cualquier profundidad.
    '*session.json'
  ]).catch(() => '')
  if (!raw) return []

  const seen = new Set<string>()
  const paths: string[] = []
  for (const line of raw.split('\n')) {
    const path = line.trim()
    if (!path.endsWith('session.json') || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }

  const docs: BranchDocInfo[] = []
  for (const path of paths.slice(0, limit)) {
    // Un `session.json` que el historial menciona puede haberse borrado después:
    // `git show` falla y esa entrada simplemente no se ofrece.
    const json = await git(root, ['show', `${branch}:${path}`]).catch(() => '')
    if (!json) continue
    try {
      const session = JSON.parse(json) as DocSession
      docs.push({
        path,
        module: session.module ?? '',
        subcategory: session.subcategory ?? '',
        feature: session.feature ?? '',
        title: session.title ?? '',
        role: session.role ?? '',
        baseUrl: session.baseUrl ?? '',
        createdAt: session.createdAt ?? ''
      })
    } catch {
      // session.json ilegible: se omite esa funcionalidad
    }
  }
  return docs
}

/**
 * Paquetes de documentación escritos en el repositorio que Git no tiene
 * registrados: carpetas nuevas sin commitear, o ya commiteadas pero cambiadas
 * después.
 *
 * Es la otra mitad de `readBranchDocs`: esa lee el historial, y por tanto no ve
 * nada de lo que se guardó sin llegar a comitear (porque el commit falló, porque
 * se guardó con Git desactivado o porque se cerró la app antes). Sin esta lectura
 * ese trabajo existe en el disco pero es invisible para la aplicación.
 *
 * Se parte de `git status` en vez de recorrer el disco: es una sola llamada, y es
 * Git quien decide qué está al día y qué no. De cada ruta pendiente se sube por
 * los directorios hasta encontrar el que tiene `session.json` —el paquete—, así
 * una captura cambiada dentro de `img/` cuenta como su paquete y las rutas ajenas
 * (que no cuelgan de ninguno) se descartan solas.
 */
export async function readPendingDocs(root: string): Promise<PendingDocInfo[]> {
  const status = await readStatus(root)
  const pending = [...new Set([...status.untracked, ...status.modified, ...status.staged])]
  if (!pending.length) return []

  /** paquete (carpeta con session.json) → rutas pendientes que le pertenecen */
  const groups = new Map<string, string[]>()
  /** carpetas ya consultadas: `git status` devuelve muchas rutas del mismo paquete */
  const isPackage = new Map<string, boolean>()

  for (const path of pending) {
    let dir = posixDirname(path)
    // Tres niveles bastan para `<paquete>/img/paso-01.png`; más arriba ya no es
    // el paquete de ese archivo, y subir sin límite acabaría atribuyendo cualquier
    // archivo del repositorio al primer paquete que hubiera por encima.
    for (let up = 0; up < 3 && dir; up++) {
      let known = isPackage.get(dir)
      if (known === undefined) {
        known = await exists(join(root, dir, 'session.json'))
        isPackage.set(dir, known)
      }
      if (known) {
        const list = groups.get(dir)
        if (list) list.push(path)
        else groups.set(dir, [path])
        break
      }
      const parent = posixDirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  const untracked = new Set(status.untracked)
  const docs: PendingDocInfo[] = []
  for (const [dir, files] of groups) {
    const sessionPath = `${dir}/session.json`
    let session: DocSession
    try {
      session = JSON.parse(await readFile(join(root, sessionPath), 'utf8')) as DocSession
    } catch {
      // session.json ilegible: sin él no se puede decir qué proceso es, y ofrecer
      // «registrar esto» sin saber qué es sería peor que no ofrecerlo.
      continue
    }
    docs.push({
      path: sessionPath,
      dir,
      module: session.module ?? '',
      subcategory: session.subcategory ?? '',
      feature: session.feature ?? '',
      title: session.title ?? '',
      role: session.role ?? '',
      baseUrl: session.baseUrl ?? '',
      createdAt: session.createdAt ?? '',
      pendingFiles: files.sort(),
      steps: Array.isArray(session.steps) ? session.steps.length : 0,
      untracked: untracked.has(sessionPath)
    })
  }
  // Lo más reciente primero: es lo que se acaba de grabar y lo que se busca.
  return docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/**
 * Registra en Git un paquete que ya está escrito en el disco.
 *
 * Se indexa la carpeta entera tal como está —no solo lo que `git status` marca—
 * porque el paquete es la unidad que tiene sentido en un commit: un `index.mdx`
 * que enlaza capturas que no viajan con él no sirve de nada. Se añaden además los
 * `_category_.json` de los niveles superiores que Git no tenga todavía: sin ellos
 * la barra lateral de Docusaurus mostraría la carpeta con su nombre en crudo.
 */
export async function commitPendingDoc(args: {
  repoRoot: string
  dir: string
  branch: string
  message: string
  push: boolean
  baseBranch?: string
}): Promise<GitCommitResult> {
  const { repoRoot, dir, branch, message, push, baseBranch } = args
  if (!dir || dir.startsWith('/') || dir.includes('..')) {
    throw new Error(`Ruta de paquete no válida: ${dir}`)
  }
  const root = await git(repoRoot, ['rev-parse', '--show-toplevel'])
  const absolute = join(root, dir)
  if (!(await exists(join(absolute, 'session.json')))) {
    throw new Error(`En ${dir} ya no hay un paquete de documentación (falta session.json).`)
  }

  const files = await listFiles(absolute)
  if (!files.length) throw new Error(`La carpeta ${dir} está vacía.`)

  // `_category_.json` de los niveles por encima del paquete, mientras sigan dentro
  // de la carpeta de documentación del repositorio.
  const status = await readStatus(root)
  const pending = new Set([...status.untracked, ...status.modified])
  let parent = posixDirname(dir)
  while (parent && parent !== '.' && parent !== '/') {
    const category = `${parent}/_category_.json`
    if (pending.has(category)) files.push(join(root, category))
    const next = posixDirname(parent)
    if (next === parent) break
    parent = next
  }

  return commitDocs({ repoRoot: root, branch, message, push, baseBranch, files })
}

/**
 * Manda un archivo o una carpeta a la papelera del sistema.
 *
 * Descartar documentación es una acción destructiva sobre trabajo real: media
 * hora de grabación puede irse en un clic. La papelera es lo que hace que ese
 * clic sea reversible sin que la aplicación tenga que inventarse una copia de
 * seguridad propia, y es donde el usuario ya sabe buscar.
 *
 * Si el sistema no puede moverlo (un volumen sin papelera, permisos), se AVISA
 * en vez de borrarlo de todos modos: quien pidió «a la papelera» no pidió
 * «bórralo para siempre». La prueba de humo sí borra directamente, para no ir
 * dejando carpetas temporales en la papelera de quien la ejecuta.
 */
async function trashPath(absolute: string): Promise<void> {
  if (process.env['DOCRECORDER_NO_TRASH']) {
    await rm(absolute, { recursive: true, force: true })
    return
  }
  try {
    await shell.trashItem(absolute)
  } catch (err) {
    throw new Error(
      `No se pudo mover a la papelera ${absolute}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }
}

/** Salida de un `git ... -z` como lista de rutas, sin el token vacío final. */
async function gitPaths(root: string, args: string[]): Promise<string[]> {
  const raw = await gitRaw(root, args).catch(() => '')
  return raw.split('\0').filter(Boolean)
}

/**
 * Descarta un paquete que Git no tiene registrado, dejando el repositorio como
 * si nunca se hubiera escrito.
 *
 * Es la otra mitad de `commitPendingDoc`: al ver lo que quedó fuera del
 * historial, unas veces se quiere registrar y otras tirar (una grabación de
 * prueba, un proceso que se documentó dos veces, un intento fallido). Sin esto la
 * única salida era ir al Finder a borrar carpetas a mano, con el riesgo de
 * llevarse por delante lo que sí estaba commiteado.
 *
 * Tres casos, y ninguno toca nada fuera de la carpeta del paquete:
 *
 *  - archivos que Git no conoce → a la papelera;
 *  - archivos ya commiteados y modificados → vuelven a su versión del commit;
 *  - archivos añadidos al índice pero nunca commiteados → se sacan del índice y
 *    van a la papelera (para Git son nuevos; en disco son un archivo más).
 *
 * Si al quitar el paquete su categoría queda vacía, esa carpeta se va también:
 * un `_category_.json` suelto dejaría en la barra lateral de Docusaurus un
 * apartado sin nada dentro. Solo si ese `_category_.json` tampoco estaba
 * registrado, claro.
 */
export async function discardPendingDoc(args: {
  repoRoot: string
  dir: string
}): Promise<DiscardResult> {
  const { dir } = args
  if (!dir || dir.startsWith('/') || dir.includes('..')) {
    throw new Error(`Ruta de paquete no válida: ${dir}`)
  }
  const root = await git(args.repoRoot, ['rev-parse', '--show-toplevel'])
  const absolute = join(root, dir)
  if (!(await exists(join(absolute, 'session.json')))) {
    throw new Error(`En ${dir} ya no hay un paquete de documentación (falta session.json).`)
  }

  const status = await readStatus(root)
  const untracked = status.untracked.filter((path) => path.startsWith(`${dir}/`))
  // Lo que el índice conoce dentro del paquete, y lo que además existe en el
  // último commit: la diferencia son los archivos «añadidos pero nunca
  // commiteados», que no se pueden restaurar porque no hay a qué volver.
  const tracked = await gitPaths(root, ['ls-files', '-z', '--', dir])
  const inHead = new Set(
    await gitPaths(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', dir])
  )
  const staleIndex = tracked.filter((path) => !inHead.has(path))

  let trashed = 0
  let restored = 0

  if (!tracked.length) {
    // Paquete entero desconocido para Git: se va tal cual, con sus capturas.
    await trashPath(absolute)
    trashed = untracked.length || 1
    // Y con él, las categorías que solo existían para contenerlo.
    const untrackedSet = new Set(status.untracked)
    let parent = posixDirname(dir)
    while (parent) {
      const rest = await readdir(join(root, parent)).catch(() => [] as string[])
      const onlyCategory = rest.length === 1 && rest[0] === '_category_.json'
      if (!onlyCategory || !untrackedSet.has(`${parent}/_category_.json`)) break
      await trashPath(join(root, parent))
      trashed++
      parent = posixDirname(parent)
    }
  } else {
    if (inHead.size) {
      // Devuelve al disco Y al índice la versión commiteada de lo que ya existía.
      await git(root, ['checkout', 'HEAD', '--', dir])
      restored = inHead.size
    }
    for (const path of staleIndex) {
      await git(root, ['rm', '--force', '--cached', '--', path]).catch(() => '')
      await trashPath(join(root, path))
      trashed++
    }
    for (const path of untracked) {
      await trashPath(join(root, path))
      trashed++
    }
  }

  const parts: string[] = []
  if (trashed) parts.push(`${trashed} archivo(s) a la papelera del sistema`)
  if (restored) parts.push(`${restored} archivo(s) devuelto(s) a su versión commiteada`)
  return {
    trashed,
    restored,
    message: parts.length
      ? `Descartado «${dir}»: ${parts.join(' y ')}.`
      : `En «${dir}» no quedaba nada que descartar.`
  }
}

/** Rutas absolutas de todos los archivos de una carpeta, recursivamente. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(full)))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

/**
 * Documentación registrada en un commit, para previsualizarla en el explorador
 * sin arrancar Docusaurus ni hacer checkout. Lee los `session.json` que el commit
 * añadió o modificó y devuelve sus pasos.
 */
export async function readCommitDocs(root: string, commit: string): Promise<CommitDocs[]> {
  const changed = await git(root, ['show', '--name-only', '--pretty=format:', commit]).catch(
    () => ''
  )
  const paths = changed
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p === 'session.json' || p.endsWith('/session.json'))

  const docs: CommitDocs[] = []
  for (const path of paths) {
    const json = await git(root, ['show', `${commit}:${path}`]).catch(() => '')
    let session: DocSession | null = null
    try {
      session = JSON.parse(json) as DocSession
    } catch {
      // session.json ilegible: se omite ese archivo del preview
    }
    if (session) docs.push({ path, session })
  }
  return docs
}

/** Un blob del commit tal cual (binario), o `null` si no está o está vacío. */
async function readBlob(root: string, commit: string, path: string): Promise<Buffer | null> {
  try {
    const { stdout } = await run('git', ['show', `${commit}:${path}`], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'buffer'
    })
    const buf = stdout as unknown as Buffer
    return buf.length ? buf : null
  } catch {
    return null
  }
}

/**
 * Una captura commiteada, como data URI, para mostrarla en la vista previa. Se
 * lee el blob binario directamente del commit (sin checkout).
 */
export async function readDocImage(
  root: string,
  commit: string,
  imagePath: string
): Promise<string | null> {
  const buf = await readBlob(root, commit, imagePath)
  return buf ? `data:image/png;base64,${buf.toString('base64')}` : null
}

/**
 * Trae una funcionalidad commiteada de vuelta a la sesión para seguir
 * editándola.
 *
 * La diferencia con la vista previa es dónde acaban las capturas: previsualizar
 * las lee en memoria, y aquí se ESCRIBEN como temporales, porque a partir de este
 * momento el paso es un paso normal del panel —se reordena, se redacta, se
 * agrupa— y al guardar se copia a `img/paso-NN.png` como cualquier otro. Sin
 * materializarlas, volver a guardar dejaría el paquete sin sus imágenes.
 *
 * Sigue siendo solo lectura sobre el repositorio: no hay checkout ni cambio de
 * rama. Lo que decide dónde se reescribirá el paquete es `outputDir`, deducido
 * quitando de la ruta los niveles que la propia sesión declara (módulo,
 * subcategoría y funcionalidad); guardando con esos mismos metadatos, el paquete
 * vuelve exactamente a donde estaba.
 */
export async function readCommitDocForEdit(
  root: string,
  commit: string,
  sessionPath: string,
  shotDir: string
): Promise<CommitDocEdit | null> {
  const json = await git(root, ['show', `${commit}:${sessionPath}`]).catch(() => '')
  if (!json) return null
  let session: DocSession
  try {
    session = JSON.parse(json) as DocSession
  } catch {
    return null
  }

  const dir = posixDirname(sessionPath)
  const parts = dir ? dir.split('/') : []
  // Módulo + funcionalidad, y la subcategoría en medio si la sesión la declara.
  const depth = session.subcategory?.trim() ? 3 : 2
  const outputRel = parts.slice(0, Math.max(0, parts.length - depth)).join('/')

  const steps: RecordedStep[] = []
  let missingImages = 0
  for (const step of session.steps ?? []) {
    let tempFile = ''
    if (step.screenshot) {
      const buf = await readBlob(root, commit, `${dir}/${step.screenshot}`)
      if (buf) {
        // El nombre lleva el commit para que dos ediciones del mismo proceso no
        // se pisen los temporales entre sí.
        tempFile = join(shotDir, `commit-${commit}-${step.screenshot.replace(/[\\/]/g, '-')}`)
        await writeFile(tempFile, buf)
      } else {
        // Una captura que el commit no trae (se borró, o el commit solo tocaba el
        // texto): el paso se conserva sin imagen en vez de perderse entero.
        missingImages++
      }
    }
    steps.push({ ...step, tempFile })
  }

  return {
    commit,
    outputDir: outputRel ? join(root, outputRel) : root,
    dir,
    session,
    steps,
    missingImages
  }
}

/** Ruta en el repo de la captura de un paso, a partir del path de su session.json. */
export function docImagePath(sessionPath: string, screenshot: string): string {
  return `${dirname(sessionPath)}/${screenshot}`.replace(/\\/g, '/')
}

/**
 * Cambia de rama aunque el paquete recién escrito estorbe.
 *
 * Git aborta un `checkout` si en el árbol hay archivos SIN SEGUIMIENTO que la
 * rama de destino también tiene: no quiere pisar algo que no sabe de dónde
 * salió. Y es exactamente lo que ocurre al reescribir una funcionalidad que ya
 * está documentada en su rama —regrabarla, o traerla de un commit para
 * corregirla— estando en otra rama: el paquete se escribe primero (para no
 * perderlo si el commit falla) y, cuando llega el momento de cambiar de rama,
 * esos archivos son «desconocidos» aquí y «conocidos» allí.
 *
 * La salida es apartar SOLO nuestros archivos —los que este guardado acaba de
 * escribir—, cambiar de rama y volver a ponerlos encima. Pisar la versión de la
 * rama con la nuestra es justo lo que se ha pedido al guardar; lo que nunca se
 * toca es un archivo ajeno, que sigue abortando el cambio de rama con el mensaje
 * de Git.
 *
 * Los archivos se apartan a un directorio temporal y se reponen SIEMPRE, también
 * si el checkout falla: una salida a medias dejaría el trabajo fuera del árbol.
 */
async function checkoutKeepingOurFiles(
  root: string,
  checkoutArgs: string[],
  /** rama (o base) cuya versión de nuestros archivos sería la que estorba */
  target: string,
  ourPaths: string[],
  untracked: Set<string>
): Promise<void> {
  const inTarget = new Set(
    await gitPaths(root, ['ls-tree', '-r', '--name-only', '-z', target, '--'])
  )
  const clash = ourPaths.filter((path) => untracked.has(path) && inTarget.has(path))
  if (!clash.length) {
    await git(root, checkoutArgs)
    return
  }

  const aside = await mkdtemp(join(tmpdir(), 'docrecorder-switch-'))
  const moved: string[] = []
  try {
    for (const path of clash) {
      await mkdir(dirname(join(aside, path)), { recursive: true })
      await rename(join(root, path), join(aside, path))
      moved.push(path)
    }
    await git(root, checkoutArgs)
  } finally {
    for (const path of moved) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      // `rename` sustituye el destino: la versión que traiga la rama se queda
      // debajo de la nuestra, que es la que se va a commitear.
      await rename(join(aside, path), join(root, path)).catch(() => undefined)
    }
    await rm(aside, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Crea (o reutiliza) la rama, indexa solo los archivos escritos y hace commit.
 *
 * `files` son rutas absolutas dentro del repositorio; se convierten a rutas
 * relativas porque es lo que espera `git add` desde la raíz.
 */
export async function commitDocs(options: GitCommitOptions): Promise<GitCommitResult> {
  const { repoRoot, branch, message, files, push, baseBranch } = options

  const invalid = validateBranchName(branch)
  if (invalid) throw new Error(invalid)

  const info = await inspectRepo(repoRoot)
  if (!info) throw new Error(`${repoRoot} no es un repositorio Git.`)

  // Las rutas deben resolverse antes de compararlas: en macOS `/var` es un
  // enlace simbólico a `/private/var`, y `git rev-parse --show-toplevel`
  // devuelve siempre la ruta real. Sin esto, `relative()` produce un camino
  // lleno de `../..` que Git rechaza por quedar «fuera del repositorio».
  const realRoot = await realpath(info.root).catch(() => info.root)
  const ourPaths = new Set<string>()
  for (const file of files) {
    const absolute = isAbsolute(file)
      ? await realpath(file).catch(() => file)
      : join(realRoot, file)
    const rel = relative(realRoot, absolute).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..')) {
      throw new Error(`El archivo ${file} queda fuera del repositorio ${realRoot}.`)
    }
    ourPaths.add(rel)
  }
  const foreignStaged = info.stagedPaths.filter((p) => !ourPaths.has(p))
  const foreignDirty = info.dirtyPaths.filter((p) => !ourPaths.has(p))

  if (foreignStaged.length) {
    throw new Error(
      `El repositorio tiene cambios ya indexados que no son de DocRecorder y acabarían dentro de este commit: ` +
        `${foreignStaged.slice(0, 3).join(', ')}${foreignStaged.length > 3 ? '…' : ''}. ` +
        `Haz commit o guárdalos en un stash antes de continuar.`
    )
  }

  const branchExists = await git(info.root, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`
  ])
    .then(() => true)
    .catch(() => false)

  const mustSwitch = info.branch !== branch
  // Solo bloquean los archivos SEGUIDOS y modificados: viajarían a la rama nueva
  // y mezclarían trabajo en curso ajeno con la documentación. Los archivos sin
  // seguimiento no bloquean —Git los conserva intactos al cambiar de rama— y
  // además incluyen los que DocRecorder acaba de escribir.
  if (mustSwitch && foreignDirty.length) {
    throw new Error(
      `Hay cambios sin guardar en «${info.branch}» que se arrastrarían a la rama «${branch}»: ` +
        `${foreignDirty.slice(0, 3).join(', ')}${foreignDirty.length > 3 ? '…' : ''}. ` +
        `Haz commit o guárdalos en un stash antes de continuar.`
    )
  }

  let createdBranch = false
  let baseNote = ''
  // Los archivos que este guardado acaba de escribir y que Git todavía no
  // conoce: son los que hay que apartar para poder cambiar de rama.
  const untracked = new Set(info.untrackedPaths)
  const ours = [...ourPaths]
  if (mustSwitch) {
    if (branchExists) {
      // Reutilizar la rama permite regrabar una funcionalidad y añadir el
      // resultado a la misma rama en vez de dispersarlo.
      await checkoutKeepingOurFiles(info.root, ['checkout', branch], branch, ours, untracked)
    } else if (info.hasCommits) {
      // Se ramifica desde la rama por defecto, no desde HEAD: así cada
      // funcionalidad genera un PR independiente (GitHub Flow). El usuario puede
      // elegir otra base en el explorador de repositorios, para continuar una
      // línea de documentación ya empezada.
      const base = baseBranch || (await detectBaseBranch(info.root))
      if (base) {
        // Una base inexistente haría que `checkout -b` fallara con un mensaje
        // de Git poco claro; conviene decir exactamente qué falta.
        const baseExists = await git(info.root, [
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${base}`
        ])
          .then(() => true)
          .catch(() => false)
        if (!baseExists) {
          throw new Error(`La rama base «${base}» no existe en ${info.root}.`)
        }
        await checkoutKeepingOurFiles(
          info.root,
          ['checkout', '-b', branch, base],
          base,
          ours,
          untracked
        )
        if (base !== info.branch) baseNote = ` desde «${base}»`
      } else {
        // Repositorio sin main/master ni origin/HEAD: no hay base evidente, así
        // que se conserva el comportamiento anterior (ramificar desde HEAD)
        // antes que fallar el guardado. Se avisa porque la rama puede quedar
        // encadenada sobre la anterior.
        await git(info.root, ['checkout', '-b', branch])
        baseNote = ` desde «${info.branch}» (no se encontró la rama por defecto del repositorio)`
      }
      createdBranch = true
    } else {
      // Repositorio sin commits: no hay de dónde ramificar todavía.
      await git(info.root, ['checkout', '-B', branch])
      createdBranch = true
    }
  }

  const relatives = [...ourPaths]
  if (!relatives.length) throw new Error('No hay archivos que registrar en el commit.')
  await git(info.root, ['add', '--', ...relatives])

  // Si nada cambió respecto al último commit, `git commit` fallaría con un
  // mensaje poco claro. Regrabar sin cambios reales es un caso normal.
  const staged = await git(info.root, ['diff', '--cached', '--name-only'])
  if (!staged) {
    return {
      repoRoot: info.root,
      branch,
      createdBranch,
      commit: null,
      committedFiles: 0,
      pushed: false,
      message: 'No había cambios que registrar: la documentación ya estaba al día.'
    }
  }

  await git(info.root, ['commit', '-m', message])
  const commit = await git(info.root, ['rev-parse', '--short', 'HEAD'])
  const committedFiles = staged.split('\n').filter(Boolean).length

  let pushed = false
  let pushNote = ''
  if (push) {
    if (!info.remoteUrl) {
      pushNote = ' El repositorio no tiene remoto «origin», así que no se subió nada.'
    } else {
      try {
        // Nunca `--force`: sobrescribiría trabajo ajeno en el remoto.
        await git(info.root, ['push', '--set-upstream', 'origin', branch])
        pushed = true
      } catch (err) {
        pushNote = ` El commit está hecho, pero el push falló: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`
      }
    }
  }

  return {
    repoRoot: info.root,
    branch,
    createdBranch,
    commit,
    committedFiles,
    pushed,
    message:
      `${createdBranch ? 'Rama creada' : 'Rama reutilizada'} «${branch}»${baseNote}, ` +
      `commit ${commit} con ${committedFiles} archivo(s).${pushNote}`
  }
}
