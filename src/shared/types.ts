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
  /**
   * Campos de un formulario agrupados en este paso. Cuando la GUI une varios
   * `fill`/`select` seguidos del mismo formulario en un solo paso (para no
   * generar una captura por campo), cada campo queda aquí como etiqueta+valor y
   * `value` deja de usarse.
   */
  fields?: Array<{ label: string; value: string }>
  /**
   * Acciones individuales que se fundieron en este paso (formulario agrupado).
   * El runner de regeneración las re-ejecuta todas y luego captura UNA imagen del
   * paso; `flow.json` también las expande. Ausente en pasos no agrupados: su
   * acción es `action` + `selectorCandidates` + `value`.
   */
  mergedActions?: FlowAction[]
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

/** Documentación (una funcionalidad) registrada en un commit, para previsualizar. */
export interface CommitDocs {
  /** ruta del session.json en el repo, p. ej. `matriculas/crear/session.json` */
  path: string
  session: DocSession
}

/* ---------- asistencia de IA para redactar los pasos (§11) ---------- */

/** Proveedores admitidos para redactar títulos y descripciones. */
export type AiProvider = 'anthropic' | 'gemini'

export interface AiSettings {
  /** proveedor que se usa al redactar */
  provider: AiProvider
  /** modelo elegido para cada proveedor; se recuerda uno por proveedor */
  models: Record<AiProvider, string>
  /**
   * Enviar también la captura del paso. Con ella el modelo ve la pantalla real y
   * sitúa el paso («en la pestaña Datos personales»); sin ella solo recibe la
   * acción, el elemento y el valor, que es bastante más barato.
   */
  useScreenshot: boolean
}

/**
 * Lo que la GUI puede saber de la configuración de IA. Las claves nunca salen
 * del proceso principal: aquí solo viaja si hay o no hay clave.
 */
export interface AiStatus {
  settings: AiSettings
  /** proveedores con clave guardada */
  configured: Record<AiProvider, boolean>
  /** el proveedor activo tiene clave: se puede redactar */
  ready: boolean
  /** las claves se guardan cifradas por el sistema operativo */
  encrypted: boolean
}

/** Redacción propuesta para un paso. */
export interface AiStepDraft {
  id: string
  title: string
  description: string
}

export interface AiDraftResult {
  drafts: AiStepDraft[]
  /**
   * Motivo por el que no se pudo completar. Puede venir junto a `drafts`: si
   * falla a mitad, lo ya redactado se aprovecha en vez de perderse.
   */
  error?: string
}

/**
 * Modelos ofrecidos por proveedor. Todos aceptan imágenes y salida estructurada,
 * que es lo que necesita la redacción; el primero de cada lista es el de partida.
 */
export const AI_MODELS: Record<AiProvider, string[]> = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-5'],
  gemini: ['gemini-3.5-flash', 'gemini-2.5-flash']
}

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  gemini: 'Gemini (Google)'
}

export const AI_PROVIDERS: AiProvider[] = ['anthropic', 'gemini']

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'anthropic',
  models: { anthropic: AI_MODELS.anthropic[0], gemini: AI_MODELS.gemini[0] },
  useScreenshot: true
}

/** Resultado de regenerar la captura de un paso (runner). */
export interface RegenStepResult {
  order: number
  title: string
  status: 'ok' | 'failed'
  /** motivo del fallo, si lo hubo */
  detail: string
}

/** Resultado global de una regeneración. */
export interface RegenReport {
  /** el usuario canceló el selector de carpeta */
  canceled?: boolean
  /** no se pudo ni empezar (p. ej. sin session.json, o sin sesión iniciada) */
  error?: string
  /** carpeta de la funcionalidad regenerada */
  featureDir?: string
  results: RegenStepResult[]
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
