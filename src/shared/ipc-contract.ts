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
  BranchDocInfo,
  CheckProgress,
  ChecksResult,
  CommitDocs,
  DiscardResult,
  DocSession,
  DocStep,
  EngineState,
  GitBranchInfo,
  GitCommitInfo,
  GitCommitResult,
  GitRepoInfo,
  GitSaveOptions,
  PendingDocInfo,
  PreviewResult,
  PreviewStatus,
  ProjectChecks,
  ProjectEntry,
  ProjectGuide,
  RecordedAction,
  SaveResult,
  SelectorCandidate,
  SessionMeta,
  StepAction,
  StepKind,
  StepNote,
  Viewport
} from './types'

/**
 * Clase de control con la que se interactuó, para decidir qué se funde solo.
 *
 * - `field`: se da un valor — escribir, elegir en un desplegable o una lista,
 *   marcar una casilla, un radio o un interruptor (también los hechos con roles
 *   ARIA sobre `div`, que es lo normal en las librerías actuales), y elegir la
 *   opción de un desplegable abierto.
 * - `tab`: una pestaña (`[role=tab]`).
 * - `action`: se ejecuta algo — botones, enlaces, `<summary>` y las opciones de
 *   un menú.
 *
 * Un envío, una tecla o una navegación no tienen familia: nunca se funden.
 */
export type StepFamily = 'field' | 'tab' | 'action'

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
   * Clase de control con la que se interactuó. Solo se funden en un paso los
   * pasos de la MISMA familia, que es lo que mantiene el corte natural del
   * flujo: los campos de un formulario entre sí, las pestañas entre sí y los
   * botones entre sí, pero el «Guardar» no se traga el formulario. `null` (o
   * ausente) = este paso no se funde solo con nada. No se persiste.
   */
  family?: StepFamily | null
  /**
   * Carga de página en la que ocurrió. Dos pasos de cargas distintas no se
   * funden aunque la URL coincida: recargar y volver a pulsar es otra cosa que
   * pulsar dos veces seguidas. No se persiste.
   */
  loadRef?: number
  /**
   * Dónde está el elemento dentro de una tabla, o `null`/ausente si no está en
   * ninguna. Es lo que permite fundir los controles de una misma **fila** (un
   * registro que se edita en línea) o de una misma **columna** (la misma acción
   * repetida sobre varios registros) sin mezclar cosas que no tienen que ver.
   * No se persiste.
   */
  rowRef?: number | null
  tableRef?: number | null
  cellRef?: number | null
  colIndex?: number | null
  /** encabezado de esa columna, para poder titular el paso agrupado */
  colHeader?: string | null
  /**
   * Campos fundidos en este paso, en orden. Es la fuente de verdad del grupo en
   * la GUI: de aquí se derivan `fields` (lo que se publica) y `mergedActions`
   * (con qué se vuelve a señalar cada elemento), y es lo que permite quitar un
   * campo suelto sin dejar descuadrado su resaltado.
   */
  groupItems?: GroupedField[]
  /**
   * Los pasos tal como eran antes de agruparlos a mano. Permite deshacer la
   * agrupación devolviendo cada uno a su sitio con SU captura, en vez de dejar
   * pasos huérfanos compartiendo la imagen del grupo. No se persiste en el
   * paquete (sí en el borrador, para que deshacer siga funcionando mañana).
   */
  groupSources?: RecordedStep[]
}

/**
 * Una funcionalidad ya commiteada, traída de vuelta a la sesión para seguir
 * editándola (§7).
 *
 * La vista previa de un commit es de solo lectura, y hasta ahora terminaba ahí:
 * para corregir una descripción o añadir un paso había que volver a grabar el
 * proceso entero. Esto cierra el círculo: los pasos vuelven con SU captura ya
 * materializada en un archivo temporal, así que a partir de aquí viajan por el
 * mismo camino que una grabación (panel, borrador, MDX y commit).
 *
 * `outputDir` es la carpeta de salida que reproduce la ruta original del
 * paquete: guardando con los mismos metadatos, el paquete se reescribe donde
 * estaba y el commit nuevo se apila encima, sin duplicar la funcionalidad.
 */
export interface CommitDocEdit {
  /** commit del que se trajo, para poder decirlo en el panel */
  commit: string
  /** carpeta de salida que hay que usar para reescribir el paquete donde estaba */
  outputDir: string
  /** ruta del paquete dentro del repositorio (la carpeta con session.json) */
  dir: string
  session: DocSession
  /** los pasos del commit, cada uno con su captura ya escrita en un temporal */
  steps: RecordedStep[]
  /** capturas del commit que no se pudieron leer (el paso queda sin imagen) */
  missingImages: number
}

/**
 * Un elemento de un paso agrupado, para volver a marcarlo en la captura.
 *
 * Lleva las dos formas de encontrarlo, porque ninguna basta sola: las
 * referencias del observador son exactas pero mueren cuando el framework
 * reemplaza el nodo (guardar un formulario, redibujar una tabla), y los
 * selectores sobreviven a eso pero pueden apuntar a otro elemento si la pantalla
 * cambió del todo. Se prueban en ese orden.
 */
export interface GroupTarget {
  /** referencias del observador a ese elemento (enfocarlo y escribir son dos) */
  refs: number[]
  /** selectores del paso, en orden de robustez */
  selectorCandidates: SelectorCandidate[]
}

/** Una pantalla o ventana que se puede capturar (§12). */
export interface CaptureSource {
  /** id de `desktopCapturer`; solo vale para esta enumeración */
  id: string
  name: string
  kind: 'screen' | 'window'
  /** miniatura en data URI para reconocerla en el selector; '' si no se pudo */
  thumbnail: string
}

/**
 * Lo que había en el portapapeles cuando el usuario pidió pegar (§12).
 *
 * Es deliberadamente crudo: el proceso principal solo dice qué encontró, y la
 * GUI decide qué paso hacer con ello (una imagen o un bloque de contenido). Con
 * el portapapeles vacío llegan los tres campos vacíos, que es un caso normal y
 * no un error.
 */
export interface ClipboardPaste {
  /** ruta del PNG temporal ya escrito, si el portapapeles traía una imagen */
  file?: string
  /** texto plano del portapapeles, si no traía imagen */
  text?: string
  /** versión enriquecida del texto, para convertir tablas a Markdown */
  html?: string
  error?: string
}

/** Un campo dentro de un paso de formulario agrupado. */
export interface GroupedField {
  /** nombre del campo, tal como se lista en el manual */
  label: string
  /** valor introducido; vacío si solo se enfocó */
  value: string
  /**
   * Acciones que lo produjeron (enfocar y escribir son dos): de sus selectores
   * sale el modo de volver a localizar el elemento para señalarlo.
   */
  actions: RecordedAction[]
  /** referencias a su elemento en el observador, para volver a resaltarlo */
  refs: number[]
}

/**
 * Algo que se quitó de la guía y todavía se puede recuperar (§19).
 *
 * Existe porque quitar es de las pocas acciones del panel que no tienen vuelta:
 * un paso grabado se lleva consigo su captura, su selector y lo redactado, y
 * volver a conseguirlo obliga a repetir el proceso en el sistema real. La
 * papelera no cambia lo que se publica —lo quitado sigue fuera del manual y del
 * paquete— sino que conserva lo suficiente para devolverlo a su sitio.
 *
 * Cada forma de quitar guarda lo suyo: `steps` para las tarjetas (una, o las
 * marcadas de golpe), y `content`/`note`/`field` para lo que se quita DENTRO de
 * una tarjeta, que no borra la tarjeta y por eso solo necesita a qué paso
 * volver.
 */
interface TrashBase {
  /** id de la entrada de la papelera (no el del paso) */
  id: string
  /** cuándo se quitó (ISO): ordena la lista y data cada entrada */
  at: string
  /** cómo se lee la entrada en la papelera («Paso 4: Pulsar «Guardar»») */
  label: string
}

/** Tarjetas quitadas del panel: el ✕ de una, o «Eliminar» sobre las marcadas. */
export interface TrashedSteps extends TrashBase {
  kind: 'steps'
  /** las tarjetas, tal como estaban, en el orden que tenían */
  steps: RecordedStep[]
  /**
   * Posición que ocupaba cada una. Restaurar las devuelve a su sitio en vez de
   * amontonarlas al final, que es lo que haría inútil recuperar el paso 3 de una
   * grabación de cuarenta.
   */
  indexes: number[]
  /**
   * Capturas que colgaban de cada carpeta quitada: id de la carpeta → ids de sus
   * capturas. Quitar una carpeta libera sus capturas en lugar de borrarlas
   * (§16), así que restaurarla tiene que volver a meterlas dentro: sin esto la
   * carpeta volvería vacía. Va por carpeta porque de una sola vez se pueden
   * quitar varias (la barra de selección), y entonces cada captura tiene que
   * saber a cuál vuelve.
   */
  members?: Record<string, string[]>
}

/** Bloque de contenido quitado con el 🗑 de su editor; el paso sigue ahí. */
export interface TrashedContent extends TrashBase {
  kind: 'content'
  stepId: string
  content: string
}

/** Nota destacada quitada con el 🗑 de su editor; el paso sigue ahí. */
export interface TrashedNote extends TrashBase {
  kind: 'note'
  stepId: string
  note: StepNote
}

/** Elemento quitado de un paso agrupado con el ✕ de su fila. */
export interface TrashedField extends TrashBase {
  kind: 'field'
  stepId: string
  /** el elemento, con sus acciones y sus referencias para volver a señalarlo */
  item: GroupedField
  /** posición que ocupaba dentro del grupo */
  index: number
  /**
   * Los pasos originales del grupo, que quitar un elemento descarta (dejan de
   * casar con lo que el grupo es). Restaurarlo devuelve también «⊟ Deshacer».
   */
  sources?: RecordedStep[]
}

export type TrashEntry = TrashedSteps | TrashedContent | TrashedNote | TrashedField

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
  /**
   * Papelera de la guía (§19). Va con el borrador para que lo quitado ayer se
   * pueda recuperar hoy: si no, cerrar la aplicación sería la manera silenciosa
   * de perder para siempre lo que todavía se podía deshacer.
   */
  trash?: TrashEntry[]
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
  /** de dónde sale el paso: cambia lo que se le puede pedir a la IA */
  kind: StepKind
  /** título actual (el que generó el motor, o el que ya editó el usuario) */
  title: string
  description: string
  value?: string
  fields?: Array<{ label: string; value: string }>
  /** cuerpo del bloque de contenido, si el paso lo lleva */
  content?: string
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
  /**
   * Material de referencia pegado por quien documenta (`meta.aiContext`). Va como
   * campo propio y no dentro de `meta` para que el prompt lo trate como lo que es:
   * datos del sistema, no la identidad del manual.
   */
  context?: string
}

/** Canales renderer → main con respuesta (ipcRenderer.invoke). */
export interface IpcInvokeMap {
  'viewport:navigate': (url: string) => EngineState
  'viewport:set-bounds': (bounds: ViewportBounds) => void
  'viewport:set-visible': (visible: boolean) => void
  'viewport:back': () => void
  'viewport:forward': () => void
  'viewport:reload': () => void
  /**
   * Cambia la escala del contenido del visor (§18) y devuelve el factor que
   * quedó, que es lo que la barra enseña en porcentaje. `set` fija uno concreto
   * (lo usa la GUI al arrancar, con el valor recordado); `in`/`out` avanzan un
   * paso de la escala y `reset` vuelve al 100 %.
   */
  'viewport:zoom': (args: { action: 'in' | 'out' | 'reset' | 'set'; factor?: number }) => number
  'engine:get-state': () => EngineState
  'recorder:start': () => EngineState
  'recorder:pause': () => EngineState
  'recorder:resume': () => EngineState
  'recorder:stop': () => EngineState
  /**
   * Re-captura un paso agrupado marcando todos sus elementos (los campos de un
   * formulario, o lo que se haya agrupado a mano). Devuelve la ruta del PNG
   * nuevo, o `null` si la captura no mejoraría la que el paso ya tiene: la
   * pantalla es otra (`url` ya no coincide) o no queda nada que marcar.
   */
  'recorder:capture-group': (args: { targets: GroupTarget[]; url?: string }) => string | null
  /** pantallas y ventanas capturables, con miniatura (o el motivo de no poder) */
  'capture:sources': () => { sources: CaptureSource[]; error?: string }
  /**
   * Captura la pantalla o ventana elegida y devuelve la ruta del PNG temporal.
   * Con `hideWindow`, HiDocs se aparta mientras dispara.
   */
  'capture:take': (args: { sourceId: string; hideWindow: boolean }) => {
    file?: string
    error?: string
  }
  /** copia una imagen del disco (elegida con un selector) a la sesión */
  'capture:import-file': () => { file?: string; error?: string; canceled?: boolean }
  /**
   * Lee el portapapeles del sistema. Si trae una imagen, la escribe como PNG en
   * la carpeta de capturas y devuelve su ruta; si no, devuelve el texto (y su
   * HTML, si lo hay) para que la GUI arme un bloque de contenido.
   */
  'clipboard:read': () => ClipboardPaste
  /**
   * Guarda como captura de la sesión la imagen ya editada en la GUI (recorte y
   * resaltado). Recibe un data URI PNG y devuelve la ruta del archivo.
   */
  'capture:save-edited': (dataUrl: string) => string | null
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
  /**
   * Funcionalidades ya documentadas en una rama, de la más reciente a la más
   * antigua. Con ellas se retoma una rama sin reescribir módulo, rol ni URL base.
   */
  'git:branch-docs': (args: { repoRoot: string; branch: string }) => BranchDocInfo[]
  /** documentación registrada en un commit, para previsualizar (solo lectura) */
  'git:commit-docs': (args: { repoRoot: string; commit: string }) => CommitDocs[]
  /**
   * Trae una funcionalidad de un commit a la sesión para volver a editarla: sus
   * pasos y sus capturas, más la carpeta de salida que la devuelve a su sitio.
   * Solo lectura sobre el repositorio: escribe únicamente los PNG temporales.
   */
  'git:commit-doc-edit': (args: {
    repoRoot: string
    commit: string
    /** ruta del session.json dentro del repo, tal como la da `git:commit-docs` */
    path: string
  }) => CommitDocEdit | null
  /** una captura commiteada como data URI, para la vista previa (solo lectura) */
  'git:doc-image': (args: { repoRoot: string; commit: string; imagePath: string }) => string | null
  /**
   * Paquetes escritos en el repositorio que Git no tiene registrados (carpetas
   * nuevas sin commitear, o cambiadas después del commit). Solo lectura: leerlos
   * es lo que permite recuperar una grabación guardada que se quedó sin commit.
   */
  'git:pending-docs': (repoRoot: string) => PendingDocInfo[]
  /**
   * Registra en Git uno de esos paquetes, tal cual está en el disco. Indexa solo
   * los archivos de su carpeta (y los `_category_.json` que le falten por encima),
   * con las mismas salvaguardas que el guardado normal.
   */
  'git:commit-pending': (args: {
    repoRoot: string
    dir: string
    branch: string
    message: string
    push: boolean
  }) => GitCommitResult
  /**
   * Descarta uno de esos paquetes: lo nuevo va a la papelera del sistema (no se
   * borra a lo bruto: se puede recuperar desde el escritorio) y lo que ya estaba
   * commiteado vuelve a su versión del último commit. Nunca toca nada fuera de la
   * carpeta del paquete.
   */
  'git:discard-pending': (args: { repoRoot: string; dir: string }) => DiscardResult
  /** repositorios de documentación ya usados, del más reciente al más antiguo */
  'projects:list': () => ProjectEntry[]
  /** quita el repositorio del registro; no toca nada en disco */
  'projects:forget': (repoRoot: string) => ProjectEntry[]
  /**
   * Si la carpeta es la raíz de un proyecto Docusaurus, devuelve su carpeta
   * `docs/` (donde la documentación sí se renderiza); si no, `null`.
   */
  'docusaurus:suggest-docs': (dir: string) => string | null
  /**
   * Qué comandos del proyecto de destino se pueden ejecutar para comprobar el
   * sitio (§17), o `null` si la carpeta de salida no está en uno.
   */
  'checks:detect': (outputDir: string) => ProjectChecks | null
  /**
   * Ejecuta las comprobaciones a petición (guardar las lanza por su cuenta).
   * El progreso llega por el evento `checks:progress`.
   */
  'checks:run': (outputDir: string) => ChecksResult | null
  /** corta la tanda en marcha (la de guardar incluida) */
  'checks:cancel': () => void
  /**
   * La guía de estilo del repositorio de destino (§20), o `null` si no tiene
   * ninguna. Es lo que hay que leer ANTES de escribir, no después de que
   * `lint:docs` bloquee el commit.
   */
  'docs:guide': (outputDir: string) => ProjectGuide | null
  /**
   * Compila el sitio y lo sirve, y abre en el navegador la guía indicada.
   * `segments` son las carpetas de la guía (módulo/subcategoría/funcionalidad).
   */
  'preview:start': (args: { outputDir: string; segments?: string[] }) => PreviewResult
  'preview:stop': () => void
  'preview:status': () => PreviewStatus
  /** guarda el borrador de la grabación en curso (autoguardado) */
  'draft:save': (draft: DraftPayload) => void
  /** carga el borrador guardado, o null si no hay */
  'draft:load': () => DraftPayload | null
  /** descarta el borrador (al finalizar o al desecharlo) */
  'draft:clear': () => void
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
  /** progreso de la redacción con IA, tras cada lote */
  'ai:progress': { done: number; total: number }
  /** progreso de la comprobación del sitio: qué comando y qué va escribiendo */
  'checks:progress': CheckProgress
  /**
   * El zoom del visor cambió sin pasar por los botones: con el teclado
   * (⌘/Ctrl + `+`, `-`, `0`) o con ⌘/Ctrl + rueda dentro del visor. Sin esto la
   * barra seguiría enseñando el porcentaje anterior, que es justo lo que esta
   * función viene a arreglar.
   */
  'viewport:zoom-changed': number
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
  'viewport:zoom',
  'engine:get-state',
  'recorder:start',
  'recorder:pause',
  'recorder:resume',
  'recorder:stop',
  'recorder:capture-group',
  'capture:sources',
  'capture:take',
  'capture:import-file',
  'capture:save-edited',
  'clipboard:read',
  'dialog:pick-output-dir',
  'session:save',
  'shell:open-path',
  'shell:open-external',
  'git:inspect',
  'git:branches',
  'git:commits',
  'git:branch-docs',
  'git:commit-docs',
  'git:commit-doc-edit',
  'git:doc-image',
  'git:pending-docs',
  'git:commit-pending',
  'git:discard-pending',
  'projects:list',
  'projects:forget',
  'docusaurus:suggest-docs',
  'checks:detect',
  'checks:run',
  'checks:cancel',
  'docs:guide',
  'preview:start',
  'preview:stop',
  'preview:status',
  'draft:save',
  'draft:load',
  'draft:clear',
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
  'ai:progress',
  'checks:progress',
  'viewport:zoom-changed'
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
