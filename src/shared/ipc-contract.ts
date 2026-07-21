/**
 * Contrato IPC tipado entre renderer y main (§9 de SPEC.md).
 *
 * Toda comunicación pasa por `contextBridge`; el renderer nunca ve `ipcRenderer`
 * directamente. Los nombres de canal se declaran una sola vez aquí para que main
 * y preload no puedan divergir.
 */

import type {
  DocStep,
  EngineState,
  GitBranchInfo,
  GitCommitInfo,
  GitRepoInfo,
  GitSaveOptions,
  ProjectEntry,
  SaveResult,
  SessionMeta,
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
  'dialog:pick-output-dir': () => string | null
  'session:save': (payload: SavePayload) => SaveResult
  'shell:open-path': (path: string) => void
  /** inspecciona el repositorio que contenga la carpeta de salida, si lo hay */
  'git:inspect': (outputDir: string) => GitRepoInfo | null
  /** ramas locales del repositorio, para el explorador (solo lectura) */
  'git:branches': (repoRoot: string) => GitBranchInfo[]
  /** historial de una rama, del commit más reciente hacia atrás (solo lectura) */
  'git:commits': (args: { repoRoot: string; branch: string }) => GitCommitInfo[]
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
}

/** Canales main → renderer (webContents.send). */
export interface IpcEventMap {
  'engine:state': EngineState
  'recorder:step': RecordedStep
  /** el atajo global Ctrl+Shift+R pide alternar pausa */
  'recorder:toggle-shortcut': void
  'engine:log': { level: 'info' | 'warn' | 'error'; message: string }
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
  'dialog:pick-output-dir',
  'session:save',
  'shell:open-path',
  'git:inspect',
  'git:branches',
  'git:commits',
  'projects:list',
  'projects:forget',
  'docusaurus:suggest-docs',
  'draft:save',
  'draft:load',
  'draft:clear'
]

export const IPC_EVENT_CHANNELS: IpcEventChannel[] = [
  'engine:state',
  'recorder:step',
  'recorder:toggle-shortcut',
  'engine:log'
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
