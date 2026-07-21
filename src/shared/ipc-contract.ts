/**
 * Contrato IPC tipado entre renderer y main (§9 de SPEC.md).
 *
 * Toda comunicación pasa por `contextBridge`; el renderer nunca ve `ipcRenderer`
 * directamente. Los nombres de canal se declaran una sola vez aquí para que main
 * y preload no puedan divergir.
 */

import type {
  AiDraftResult,
  AiProvider,
  AiSettings,
  AiStatus,
  CommitDocs,
  DocStep,
  EngineState,
  GitBranchInfo,
  GitCommitInfo,
  GitRepoInfo,
  GitSaveOptions,
  FlowAction,
  ProjectEntry,
  RegenReport,
  RegenStepResult,
  SaveResult,
  SessionMeta,
  StepAction,
  Viewport
} from './types'

/**
 * Paso tal como viaja del motor a la GUI: además de los campos persistidos,
 * lleva la ruta absoluta de la captura temporal, que al guardar se copia a
 * `img/paso-NN.png`.
 */
export interface RecordedStep extends DocStep {
  /** ruta absoluta al PNG temporal (fuera del paquete final) */
  tempFile: string
  /**
   * El elemento es un campo de formulario (input de texto, textarea o select).
   * Solo se usa en la GUI para agrupar: un clic en un campo (enfocarlo antes de
   * escribir) cuenta como parte del formulario; un clic en un botón, no. No se
   * persiste.
   */
  isFormField?: boolean
  /**
   * Referencia al elemento dentro del observador, para poder volver a marcarlo
   * al re-capturar un paso de formulario agrupado. No se persiste: solo vale
   * mientras la página siga cargada.
   */
  ref?: number
  /**
   * Campos fundidos en este paso, en orden. Es la fuente de verdad del grupo en
   * la GUI: de aquí se derivan `fields` (lo que se publica) y `mergedActions`
   * (lo que reproduce el runner), y es lo que permite quitar un campo suelto sin
   * dejar descuadrada su acción ni su resaltado.
   */
  groupItems?: GroupedField[]
}

/** Un campo dentro de un paso de formulario agrupado. */
export interface GroupedField {
  /** nombre del campo, tal como se lista en el manual */
  label: string
  /** valor introducido; vacío si solo se enfocó */
  value: string
  /**
   * Acciones que lo produjeron (enfocar y escribir son dos), para que el runner
   * reproduzca el paso igual que ocurrió.
   */
  actions: FlowAction[]
  /** referencias a su elemento en el observador, para volver a resaltarlo */
  refs: number[]
}

/**
 * Borrador de la grabación en curso, persistido para poder cerrar la app y
 * continuar otro día (§8). Incluye los pasos con su captura y la configuración
 * de la sesión y de Git.
 */
export interface DraftPayload {
  meta: SessionMeta
  steps: RecordedStep[]
  sessionId: string
  createdAt: string
  outputDir: string
  git: {
    enabled: boolean
    push: boolean
    branchOverride: string | null
    messageOverride: string | null
    baseBranch: string | null
  }
  /** ISO; se muestra al ofrecer la restauración */
  savedAt: string
}

export interface ViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SavePayload {
  meta: SessionMeta
  viewport: Viewport
  sessionId: string
  createdAt: string
  outputDir: string
  steps: RecordedStep[]
  /** ausente = guardar solo en disco, sin tocar ningún repositorio */
  git?: GitSaveOptions
}

/**
 * Un paso tal como se le describe a la IA. Es un subconjunto deliberado de
 * `RecordedStep`: los selectores y los rectángulos no ayudan a redactar y solo
 * gastarían tokens.
 */
export interface AiStepInput {
  id: string
  order: number
  action: StepAction
  /** título actual (el que generó el motor, o el que ya editó el usuario) */
  title: string
  description: string
  value?: string
  fields?: Array<{ label: string; value: string }>
  url: string
  /**
   * Ruta absoluta de la captura. La lee el proceso principal, no el renderer, y
   * solo si la configuración pide enviarla.
   */
  screenshot?: string
}

export interface AiDraftRequest {
  meta: SessionMeta
  /**
   * Título de TODOS los pasos de la sesión, en orden. Da a la IA el hilo del
   * flujo completo aunque solo se le pida redactar unos pocos.
   */
  outline: Array<{ order: number; title: string }>
  /** pasos que hay que redactar */
  steps: AiStepInput[]
}

/** Canales renderer → main con respuesta (ipcRenderer.invoke). */
export interface IpcInvokeMap {
  'viewport:navigate': (url: string) => EngineState
  'viewport:set-bounds': (bounds: ViewportBounds) => void
  'viewport:set-visible': (visible: boolean) => void
  'viewport:back': () => void
  'viewport:forward': () => void
  'viewport:reload': () => void
  'engine:get-state': () => EngineState
  'recorder:start': () => EngineState
  'recorder:pause': () => EngineState
  'recorder:resume': () => EngineState
  'recorder:stop': () => EngineState
  /**
   * Re-captura un paso de formulario agrupado marcando todos sus campos.
   * Devuelve la ruta del PNG nuevo, o `null` si ya no se pudo marcar ninguno.
   */
  'recorder:capture-group': (args: { refs: number[] }) => string | null
  'dialog:pick-output-dir': () => string | null
  'session:save': (payload: SavePayload) => SaveResult
  'shell:open-path': (path: string) => void
  /** abre una URL en el navegador del sistema (solo http/https) */
  'shell:open-external': (url: string) => void
  /** inspecciona el repositorio que contenga la carpeta de salida, si lo hay */
  'git:inspect': (outputDir: string) => GitRepoInfo | null
  /** ramas locales del repositorio, para el explorador (solo lectura) */
  'git:branches': (repoRoot: string) => GitBranchInfo[]
  /** historial de una rama, del commit más reciente hacia atrás (solo lectura) */
  'git:commits': (args: { repoRoot: string; branch: string }) => GitCommitInfo[]
  /** documentación registrada en un commit, para previsualizar (solo lectura) */
  'git:commit-docs': (args: { repoRoot: string; commit: string }) => CommitDocs[]
  /** una captura commiteada como data URI, para la vista previa (solo lectura) */
  'git:doc-image': (args: { repoRoot: string; commit: string; imagePath: string }) => string | null
  /** repositorios de documentación ya usados, del más reciente al más antiguo */
  'projects:list': () => ProjectEntry[]
  /** quita el repositorio del registro; no toca nada en disco */
  'projects:forget': (repoRoot: string) => ProjectEntry[]
  /**
   * Si la carpeta es la raíz de un proyecto Docusaurus, devuelve su carpeta
   * `docs/` (donde la documentación sí se renderiza); si no, `null`.
   */
  'docusaurus:suggest-docs': (dir: string) => string | null
  /** guarda el borrador de la grabación en curso (autoguardado) */
  'draft:save': (draft: DraftPayload) => void
  /** carga el borrador guardado, o null si no hay */
  'draft:load': () => DraftPayload | null
  /** descarta el borrador (al finalizar o al desecharlo) */
  'draft:clear': () => void
  /**
   * Regenera las capturas de una funcionalidad re-ejecutando su flujo en el visor
   * autenticado. Sin `featureDir`, pide la carpeta con un selector; con él, la usa
   * directamente. El progreso llega por el evento `runner:progress`.
   */
  'runner:regenerate': (featureDir?: string) => RegenReport
  /** configuración de IA y si cada proveedor tiene clave (nunca la clave en sí) */
  'ai:status': () => AiStatus
  /** guarda o borra (cadena vacía) la clave de un proveedor */
  'ai:set-key': (args: { provider: AiProvider; key: string }) => AiStatus
  'ai:set-settings': (patch: Partial<AiSettings>) => AiStatus
  /** redacta título y descripción de los pasos pedidos; progreso por `ai:progress` */
  'ai:draft': (request: AiDraftRequest) => AiDraftResult
}

/** Canales main → renderer (webContents.send). */
export interface IpcEventMap {
  'engine:state': EngineState
  'recorder:step': RecordedStep
  /** el atajo global Ctrl+Shift+R pide alternar pausa */
  'recorder:toggle-shortcut': void
  'engine:log': { level: 'info' | 'warn' | 'error'; message: string }
  /** progreso de la regeneración, un paso a la vez */
  'runner:progress': RegenStepResult
  /** progreso de la redacción con IA, tras cada lote */
  'ai:progress': { done: number; total: number }
}

export type IpcInvokeChannel = keyof IpcInvokeMap
export type IpcEventChannel = keyof IpcEventMap

export const IPC_INVOKE_CHANNELS: IpcInvokeChannel[] = [
  'viewport:navigate',
  'viewport:set-bounds',
  'viewport:set-visible',
  'viewport:back',
  'viewport:forward',
  'viewport:reload',
  'engine:get-state',
  'recorder:start',
  'recorder:pause',
  'recorder:resume',
  'recorder:stop',
  'recorder:capture-group',
  'dialog:pick-output-dir',
  'session:save',
  'shell:open-path',
  'shell:open-external',
  'git:inspect',
  'git:branches',
  'git:commits',
  'git:commit-docs',
  'git:doc-image',
  'projects:list',
  'projects:forget',
  'docusaurus:suggest-docs',
  'draft:save',
  'draft:load',
  'draft:clear',
  'runner:regenerate',
  'ai:status',
  'ai:set-key',
  'ai:set-settings',
  'ai:draft'
]

export const IPC_EVENT_CHANNELS: IpcEventChannel[] = [
  'engine:state',
  'recorder:step',
  'recorder:toggle-shortcut',
  'engine:log',
  'runner:progress',
  'ai:progress'
]

/** Protocolo custom que sirve las capturas temporales al renderer. */
export const SHOT_PROTOCOL = 'docshot'

/** Convierte una ruta absoluta de captura en URL cargable desde el renderer. */
export function shotUrl(absolutePath: string): string {
  return `${SHOT_PROTOCOL}://shot/${encodeURIComponent(absolutePath)}`
}

/** API que `contextBridge` expone en `window.docrecorder`. */
export interface DocRecorderApi {
  invoke<C extends IpcInvokeChannel>(
    channel: C,
    ...args: Parameters<IpcInvokeMap[C]>
  ): Promise<ReturnType<IpcInvokeMap[C]>>
  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): () => void
}
