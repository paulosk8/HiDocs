import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { relative, isAbsolute, join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  CommitDocs,
  DocSession,
  GitBranchInfo,
  GitCommitInfo,
  GitCommitOptions,
  GitCommitResult,
  GitRepoInfo
} from '../shared/types'
export { suggestBranchName, suggestCommitMessage } from '../shared/naming'

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
  const raw = await gitRaw(root, ['status', '--porcelain', '-z', '--untracked-files=all']).catch(
    () => ''
  )
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

/**
 * Una captura commiteada, como data URI, para mostrarla en la vista previa. Se
 * lee el blob binario directamente del commit (sin checkout).
 */
export async function readDocImage(
  root: string,
  commit: string,
  imagePath: string
): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['show', `${commit}:${imagePath}`], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'buffer'
    })
    const buf = stdout as unknown as Buffer
    if (!buf.length) return null
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/** Ruta en el repo de la captura de un paso, a partir del path de su session.json. */
export function docImagePath(sessionPath: string, screenshot: string): string {
  return `${dirname(sessionPath)}/${screenshot}`.replace(/\\/g, '/')
}

/** Git rechaza estos patrones en `check-ref-format`; se avisa antes de intentarlo. */
export function validateBranchName(name: string): string | null {
  if (!name.trim()) return 'El nombre de la rama no puede estar vacío.'
  if (/\s/.test(name)) return 'El nombre de la rama no puede contener espacios.'
  if (/\.\.|@\{|^-|\/$|\.$|\.lock$/.test(name) || /[~^:?*[\\]/.test(name)) {
    return 'El nombre de la rama contiene caracteres que Git no admite.'
  }
  return null
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
  if (mustSwitch) {
    if (branchExists) {
      // Reutilizar la rama permite regrabar una funcionalidad y añadir el
      // resultado a la misma rama en vez de dispersarlo.
      await git(info.root, ['checkout', branch])
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
        await git(info.root, ['checkout', '-b', branch, base])
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
