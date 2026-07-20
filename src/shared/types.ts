/**
 * Modelo de datos del grabador (§6 de SPEC.md).
 * Este archivo es compartido por main, preload y renderer: no debe importar
 * nada de Node ni del DOM.
 */

export type StepAction = 'click' | 'fill' | 'select' | 'submit' | 'press' | 'navigate'

export type SelectorStrategy = 'testid' | 'id' | 'role' | 'text' | 'css'

export interface SelectorCandidate {
  strategy: SelectorStrategy
  value: string
  /** 0-100, robustez estimada. Mayor = más estable frente a cambios de UI. */
  score: number
}

export interface BoundingRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DocStep {
  id: string
  order: number
  action: StepAction
  title: string
  description: string
  selectorCandidates: SelectorCandidate[]
  /** para fill/select ("***" si es password) */
  value?: string
  /** metadato: URL en el momento de la interacción */
  url: string
  /** ruta relativa dentro del paquete exportado: img/paso-03.png */
  screenshot: string
  boundingRect: BoundingRect
  /** false = paso solo de navegación, no se documenta */
  includeInDocs: boolean
  timestamp: string
}

export interface Viewport {
  width: number
  height: number
}

export interface DocSession {
  id: string
  module: string
  feature: string
  title: string
  /** rol del usuario que ejecuta el flujo */
  role: string
  baseUrl: string
  viewport: Viewport
  createdAt: string
  steps: DocStep[]
}

export interface SessionMeta {
  module: string
  feature: string
  title: string
  role: string
  baseUrl: string
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 }

/** Estado del motor de grabación, reflejado en el indicador de la barra superior. */
export type RecorderStatus = 'idle' | 'recording' | 'paused'

export interface EngineState {
  status: RecorderStatus
  /** true cuando Playwright está adjunto al viewport vía CDP */
  attached: boolean
  /** URL actual del viewport */
  url: string
  /** último error del motor, si lo hubo */
  error?: string
}

/**
 * Insumo del runner futuro (§7): solo acciones + selectores, sin textos
 * editoriales ni rutas de imágenes.
 */
export interface FlowAction {
  order: number
  action: StepAction
  selectorCandidates: SelectorCandidate[]
  value?: string
  url: string
}

export interface Flow {
  sessionId: string
  module: string
  feature: string
  baseUrl: string
  viewport: Viewport
  actions: FlowAction[]
}

export interface SaveResult {
  /** carpeta final: <root>/<module>/<feature> */
  path: string
  stepsWritten: number
  imagesWritten: number
  /** presente solo si se pidió registrar el resultado en Git */
  git?: GitCommitResult
  /** el commit se pidió pero falló; el paquete en disco sí se escribió */
  gitError?: string
}

/**
 * Estado del repositorio que contiene la carpeta de salida (§ fase Git).
 * `null` cuando esa carpeta no está dentro de ningún repositorio.
 */
export interface GitRepoInfo {
  root: string
  /** rama actualmente activa */
  branch: string
  /** un repositorio recién creado aún no tiene HEAD resoluble */
  hasCommits: boolean
  remoteUrl: string | null
  /** rutas con cambios ya en el índice */
  stagedPaths: string[]
  /** rutas seguidas y modificadas en el árbol de trabajo */
  dirtyPaths: string[]
  /** rutas sin seguimiento (no impiden cambiar de rama) */
  untrackedPaths: string[]
  /**
   * Rama de la que nacen las ramas de documentación (`main` habitualmente), o
   * `null` si el repositorio no declara ninguna reconocible.
   */
  defaultBranch: string | null
}

/** Una rama local, para el explorador de repositorios (solo lectura). */
export interface GitBranchInfo {
  name: string
  /** rama activa en el árbol de trabajo */
  current: boolean
  /** resumen del último commit, para situar la rama de un vistazo */
  lastCommitSubject: string
  lastCommitDate: string
  /** commits que tiene por delante de la rama por defecto */
  aheadOfDefault: number
}

/** Un commit del historial de una rama (solo lectura). */
export interface GitCommitInfo {
  hash: string
  subject: string
  author: string
  date: string
}

export interface GitCommitOptions {
  repoRoot: string
  branch: string
  message: string
  /** rutas absolutas de los archivos escritos por DocRecorder */
  files: string[]
  push: boolean
  /**
   * Rama desde la que crear la rama nueva. Si se omite, se usa la rama por
   * defecto del repositorio: cada documentación debe abrir su propio PR, no
   * encadenarse sobre la anterior.
   */
  baseBranch?: string
}

export interface GitCommitResult {
  repoRoot: string
  branch: string
  createdBranch: boolean
  /** hash corto, o null si no había nada que registrar */
  commit: string | null
  committedFiles: number
  pushed: boolean
  /** resumen legible para mostrar en la GUI */
  message: string
}

/** Lo que la GUI envía al guardar cuando el usuario activa la integración Git. */
export interface GitSaveOptions {
  enabled: boolean
  branch: string
  message: string
  push: boolean
  /** elegida en el explorador de repositorios; sin ella se usa la por defecto */
  baseBranch?: string
}

/**
 * Repositorio de documentación que el usuario ya ha usado.
 *
 * El registro solo recuerda carpetas locales: la app no clona ni crea nada en
 * GitHub. Sirve para volver a un repositorio sin tener que buscarlo otra vez en
 * el disco.
 */
export interface ProjectEntry {
  /** raíz del repositorio */
  root: string
  /** nombre mostrado: la carpeta raíz */
  label: string
  /** ISO; ordena la lista por uso más reciente */
  lastUsedAt: string
  /** última carpeta de salida usada dentro de ese repositorio */
  lastOutputDir: string
  /** el repositorio puede haberse movido o borrado desde la última vez */
  missing?: boolean
}
