import { create } from 'zustand'
import type {
  CommitDocEdit,
  DraftPayload,
  GroupTarget,
  GroupedField,
  RecordedStep,
  StepFamily
} from '../../shared/ipc-contract'
import {
  DEFAULT_VIEWPORT,
  type AiStatus,
  type AiStepDraft,
  type BranchDocInfo,
  type CheckProgress,
  type ChecksResult,
  type FlowAction,
  type GitRepoInfo,
  type ProjectChecks,
  type EngineState,
  type RecorderStatus,
  type RegenReport,
  type RegenStepResult,
  type SelectorCandidate,
  type SessionMeta,
  type Viewport
} from '../../shared/types'
import { DEFAULT_ZOOM, clampZoom } from '../../shared/zoom'

/**
 * De dónde salió la documentación que hay en el panel, cuando no la ha grabado
 * esta sesión. Se muestra en la franja de edición del panel.
 */
export interface EditingSource {
  /** título legible de la funcionalidad que se está editando */
  title: string
  /** carpeta del paquete dentro del repositorio */
  dir: string
  /** commit del que se trajo */
  commit: string
  /** rama en la que se registrará la corrección */
  branch: string
  /** pasos que traía al cargarse, para saber si se ha tocado algo */
  loadedSteps: number
}

interface SessionState {
  sessionId: string
  createdAt: string
  meta: SessionMeta
  viewport: Viewport
  outputDir: string
  status: RecorderStatus
  attached: boolean
  currentUrl: string
  error: string | null
  steps: RecordedStep[]
  /** id del paso recién llegado, para hacer scroll y enfocar su título (§8) */
  focusStepId: string | null
  /**
   * Tarjeta en la que está trabajando el usuario: la última que llegó grabando o
   * la última que tocó con el ratón o el teclado. A diferencia de `focusStepId`
   * —que se consume en cuanto se hace el scroll— esta se conserva, porque es la
   * que decide DÓNDE se inserta el siguiente paso manual: junto al paso que se
   * acaba de documentar, no al final de una lista de cincuenta. `null` = al final.
   */
  activeStepId: string | null
  /**
   * Pasos marcados en el panel. La selección es lo que permite agrupar a mano
   * cualquier combinación de pasos —botones, filas de una tabla, un selector con
   * su opción—, más allá de los campos de formulario que el motor une solo.
   */
  selectedIds: string[]
  /**
   * Secciones plegadas en el panel. Es estado de la vista, no del documento: una
   * sección plegada oculta sus pasos para poder trabajar con listas largas, pero
   * el manual sale igual. Se pliega/despliega con el chevrón de la sección.
   */
  collapsedSections: string[]
  /**
   * Documentación ya publicada que se trajo a la sesión para corregirla (§16), o
   * `null` en una grabación normal.
   *
   * Existe para que la edición **se pueda cancelar**. Al cargar un commit, el
   * panel se llena de pasos que nadie ha grabado en esta sesión, y sin decirlo la
   * única salida visible es ■, que guarda y comitea: quien solo quería mirar se
   * encuentra con que la salida es publicar. Con esto el panel dice qué se está
   * editando, dónde va a ir y ofrece descartarlo sin registrar nada.
   */
  editing: EditingSource | null

  /** repositorio que contiene la carpeta de salida, o null si no hay ninguno */
  gitRepo: GitRepoInfo | null
  gitEnabled: boolean
  gitPush: boolean
  /**
   * Comprobar el sitio antes de registrar en Git (§18). Preferencia del usuario,
   * persistida: compilar tarda, y hay tandas en las que se prefiere registrar y
   * revisar después.
   */
  gitVerify: boolean

  /**
   * Comandos que el proyecto de destino ofrece, o `null` si la carpeta de salida
   * no está dentro de un proyecto Docusaurus (entonces no hay nada que ejecutar
   * y guardar no se detiene a comprobar nada).
   */
  docsChecks: ProjectChecks | null
  /** tanda en marcha: qué comando va y qué lleva escrito */
  checksRun: {
    purpose: ChecksPurpose
    label: string
    index: number
    total: number
    lines: string[]
  } | null
  /** lo que hay que leer cuando termina mal (o cuando la vista previa no sale) */
  checksReport: {
    purpose: ChecksPurpose
    result?: ChecksResult
    error?: string
  } | null
  /** vista previa servida en marcha, con su dirección */
  previewUrl: string | null
  /**
   * Rama de trabajo: donde se registrará esta grabación. `null` = todavía no se
   * ha elegido ninguna, y entonces se usa la sugerida a partir del módulo
   * (`suggestBranchName`). La eligen el selector de la franja de estado, el campo
   * de la sección Git y el explorador de proyectos: los tres escriben aquí, así
   * que no hay dos fuentes de verdad sobre a qué rama va el commit.
   */
  gitBranchOverride: string | null
  gitMessageOverride: string | null
  /**
   * Lo que ya documenta la rama de trabajo (leído de git). Alimenta el
   * autocompletado de módulo/subcategoría en la barra superior y el árbol del
   * selector de rama, para no crear categorías duplicadas por variantes de slug.
   */
  branchDocs: BranchDocInfo[]
  /**
   * Rama desde la que nacerá la rama de documentación, elegida en el explorador.
   * `null` = usar la rama por defecto del repositorio, que es lo correcto salvo
   * que se quiera continuar una línea de documentación ya empezada.
   */
  gitBaseBranch: string | null
  /** el selector de rama de trabajo (franja de estado) está desplegado */
  branchPickerOpen: boolean
  /** el explorador de repositorios está abierto */
  projectsOpen: boolean
  /**
   * Paso cuyo bloque de contenido se está editando a pantalla completa. Vive en
   * el store, y no dentro de la tarjeta, porque el visor nativo se pinta por
   * encima del HTML: el panel necesita saber que hay una superposición abierta
   * para ocultarlo mientras dure.
   */
  wideContentId: string | null
  /** la sección de ayuda está abierta */
  helpOpen: boolean
  /** el aviso inicial sobre el uso con Docusaurus está abierto */
  docusaurusIntroOpen: boolean
  /** tema de la interfaz; se aplica a <html data-theme> y se persiste */
  theme: 'light' | 'dark'
  /**
   * El panel de pasos está colapsado a una tira fina. Colapsarlo devuelve el
   * ancho al viewport para que la página que se documenta muestre su layout de
   * escritorio (su menú lateral se oculta si el viewport es estrecho).
   */
  panelCollapsed: boolean
  /**
   * Hay (o se está cargando) una página en el visor. Mientras es `false`, la
   * vista nativa se mantiene oculta y el hueco muestra el estado inicial del
   * DOM: si no, `about:blank` taparía ese onboarding con un rectángulo vacío.
   */
  viewportActive: boolean
  /**
   * Escala del contenido del visor (§19). La aplica el proceso principal sobre
   * el `WebContentsView`; aquí se guarda solo para enseñar el porcentaje y para
   * recordarla entre usos.
   */
  viewportZoom: number
  /** estado del runner de regeneración de capturas */
  runnerPhase: 'idle' | 'running' | 'done'
  /** resultados por paso, según van llegando */
  runnerProgress: RegenStepResult[]
  /** informe final de la regeneración */
  runnerReport: RegenReport | null
  /**
   * Fundir en un solo paso los controles seguidos del mismo tipo: los campos de
   * un formulario, las casillas de una columna de la tabla, las pestañas o los
   * botones. Evita una captura por cada clic. Preferencia persistida.
   */
  groupConsecutive: boolean

  /**
   * Configuración de IA, tal como la conoce el main. `null` mientras no ha
   * llegado; la clave nunca está aquí, solo si existe o no.
   */
  aiStatus: AiStatus | null
  /** los ajustes de IA están abiertos */
  aiOpen: boolean
  /** el material de referencia para la IA está abierto */
  aiContextOpen: boolean
  /** la lista de paquetes escritos y sin registrar en Git está abierta */
  pendingDocsOpen: boolean
  /** pasos que la IA está redactando ahora mismo */
  aiBusyIds: string[]
  /** avance del último «redactar todos», para la etiqueta del botón */
  aiProgress: { done: number; total: number } | null
  /** último fallo de la IA, para avisar sin romper la grabación */
  aiError: string | null

  setMeta: (patch: Partial<SessionMeta>) => void
  setOutputDir: (dir: string) => void
  applyEngineState: (state: EngineState) => void
  /**
   * Añade un paso, fundiéndolo con el anterior si ambos son campos del mismo
   * formulario. Devuelve el paso resultante SOLO cuando hubo fusión, para que
   * quien llama pueda pedir una captura nueva con todos sus campos marcados.
   */
  addStep: (step: RecordedStep) => RecordedStep | null
  /** sustituye la captura de un paso por la del grupo re-capturado */
  applyGroupShot: (id: string, tempFile: string) => void
  /**
   * Quita un campo de un paso de formulario agrupado (con su acción y su
   * resaltado). Devuelve el paso resultante para poder rehacer su captura.
   */
  removeGroupField: (stepId: string, label: string) => RecordedStep | null
  /**
   * Añade un paso escrito a mano: una captura ajena al visor, una imagen pegada
   * (ambas con su archivo ya escrito) o un bloque de contenido.
   *
   * Se coloca justo DESPUÉS de la tarjeta activa, que es donde el usuario está
   * mirando: documentando se graba un paso y acto seguido se pega la imagen o la
   * tabla que lo acompaña. Sin tarjeta activa se añade al final. Para moverlo
   * está el arrastre, como con cualquier otro paso.
   */
  addManualStep: (step: {
    kind: 'capture' | 'image' | 'content' | 'section' | 'group'
    title: string
    tempFile?: string
    /** cuerpo inicial del bloque, cuando viene pegado del portapapeles */
    content?: string
  }) => void
  updateStep: (id: string, patch: Partial<RecordedStep>) => void
  removeStep: (id: string) => void

  /** pliega o despliega una sección o una carpeta (solo afecta a la vista) */
  toggleSection: (id: string) => void
  /**
   * Mete un paso en una carpeta de capturas (§17). Es el gesto de arrastrar una
   * tarjeta hasta la zona de la carpeta: no exige que el paso esté al lado ni que
   * sea de ningún tipo concreto, que es justo lo que ⊞ Agrupar no permite.
   */
  addToGroup: (stepId: string, groupId: string) => void
  /** Saca un paso de su carpeta y lo deja suelto justo detrás de ella. */
  removeFromGroup: (stepId: string) => void
  /** marca o desmarca un paso para agruparlo con otros */
  toggleSelect: (id: string) => void
  clearSelection: () => void
  /**
   * Funde los pasos marcados en uno solo. Devuelve el paso resultante para poder
   * rehacer su captura con todos sus elementos señalados, o `null` si la
   * selección no se puede agrupar (ver `selectionProblem`).
   */
  groupSelected: () => RecordedStep | null
  /** Deshace una agrupación manual y devuelve cada paso a su sitio. */
  ungroupStep: (id: string) => void
  /** Elimina de golpe los pasos marcados. */
  removeSelected: () => void
  reorderSteps: (fromIndex: number, toIndex: number) => void
  clearFocus: () => void
  /** anota en qué tarjeta está trabajando el usuario (ver `activeStepId`) */
  setActiveStep: (id: string | null) => void
  resetSteps: () => void
  /** carga un borrador guardado para continuar donde se dejó */
  restoreDraft: (draft: DraftPayload) => void
  /**
   * Trae a la sesión una funcionalidad ya commiteada para volver a editarla: sus
   * pasos con sus capturas, sus metadatos, la carpeta que la devuelve a su sitio
   * y la rama del commit. Guardar después reescribe ese mismo paquete y añade un
   * commit encima.
   */
  loadCommitDoc: (payload: CommitDocEdit, branch: string) => void
  /**
   * Cancela la edición de algo ya publicado sin registrar nada: vacía el panel y
   * deja la sesión lista para otra cosa. El commit original no se toca (nunca se
   * tocó: cargarlo solo leyó de Git).
   */
  discardEditing: () => void
  /** deja la sesión lista para documentar una funcionalidad nueva (tras guardar) */
  startFreshSession: () => void

  setGitRepo: (repo: GitRepoInfo | null) => void
  setGit: (patch: Partial<Pick<SessionState, 'gitEnabled' | 'gitPush' | 'gitVerify'>>) => void
  setGitBranch: (value: string | null) => void
  setGitMessage: (value: string | null) => void
  setGitBaseBranch: (value: string | null) => void
  /**
   * Retoma una rama ya existente: fija la rama de trabajo y, con la última
   * funcionalidad documentada en ella, rellena los metadatos que estén vacíos.
   * `enableGit` distingue elegirla a mano (sí: se ha pedido comitear ahí) de
   * heredarla del repositorio al arrancar (no: nadie ha pedido nada todavía).
   */
  adoptBranch: (branch: string, doc?: BranchDocInfo | null, enableGit?: boolean) => void
  /** Carga los metadatos completos de una funcionalidad ya documentada. */
  loadBranchDoc: (doc: BranchDocInfo) => void
  /** Prepara una grabación nueva dentro de una categoría/subcategoría existente. */
  pickCategory: (module: string, subcategory: string) => void
  /** Registra lo documentado en la rama de trabajo (para autocompletar y el árbol). */
  setBranchDocs: (docs: BranchDocInfo[]) => void
  setBranchPickerOpen: (open: boolean) => void
  setProjectsOpen: (open: boolean) => void
  setWideContentId: (id: string | null) => void
  setHelpOpen: (open: boolean) => void
  /** cierra el aviso inicial; si `remember`, no se vuelve a mostrar */
  dismissDocusaurusIntro: (remember: boolean) => void
  /** reabre el aviso inicial (desde la ayuda) */
  openDocusaurusIntro: () => void
  togglePanel: () => void
  toggleTheme: () => void
  setViewportActive: (active: boolean) => void
  /** guarda el zoom que devolvió main (no lo aplica: eso ya está hecho) */
  setViewportZoom: (factor: number) => void
  setGroupConsecutive: (value: boolean) => void
  runnerStart: () => void
  runnerProgressAdd: (result: RegenStepResult) => void
  runnerFinish: (report: RegenReport) => void
  runnerClose: () => void

  setDocsChecks: (checks: ProjectChecks | null) => void
  /** empieza una tanda: el diálogo aparece antes de que llegue la primera línea */
  checksStart: (purpose: ChecksPurpose) => void
  checksProgress: (progress: CheckProgress) => void
  /** termina la tanda: sin argumentos, salió bien y no hay nada que mostrar */
  checksFinish: (report?: { result?: ChecksResult; error?: string }) => void
  /** cierra el informe (el usuario ya lo leyó) */
  checksClose: () => void
  setPreviewUrl: (url: string | null) => void

  setAiStatus: (status: AiStatus) => void
  setAiOpen: (open: boolean) => void
  setAiContextOpen: (open: boolean) => void
  setPendingDocsOpen: (open: boolean) => void
  setAiBusy: (ids: string[]) => void
  setAiProgress: (progress: { done: number; total: number } | null) => void
  setAiError: (message: string | null) => void
  /** vuelca las redacciones propuestas sobre sus pasos */
  applyAiDrafts: (drafts: AiStepDraft[]) => void
}

const GROUP_KEY = 'docrecorder.groupConsecutive'
const VERIFY_KEY = 'docrecorder.verifyBeforeCommit'

/** Líneas de salida que se guardan del comando en marcha, para enseñar el final. */
const CHECK_LINES = 60

/** Para qué se está comprobando: cambia lo que se ofrece al terminar. */
export type ChecksPurpose = 'commit' | 'preview'

/** Agrupar seguidos está activado salvo que el usuario lo haya desactivado. */
function initialGroupConsecutive(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * Comprobar antes de registrar viene activado: publicar un MDX que no compila es
 * justo lo que esta comprobación existe para evitar, y en un proyecto sin los
 * comandos no cuesta nada porque no hay nada que ejecutar.
 */
function initialVerify(): boolean {
  try {
    return localStorage.getItem(VERIFY_KEY) !== '0'
  } catch {
    return true
  }
}

/** Nombre del campo de un paso `fill`/`select`/clic, del último «…» del título. */
function fieldLabel(step: RecordedStep): string {
  const matches = [...step.title.matchAll(/«([^»]*)»/g)]
  return matches.length ? matches[matches.length - 1][1] : step.title
}

/** Acción reproducible de un paso, para el `flow.json` que usa el runner. */
function toFlowAction(step: RecordedStep): FlowAction {
  const action: FlowAction = {
    order: 0, // se renumera al guardar
    action: step.action,
    selectorCandidates: step.selectorCandidates,
    url: step.url
  }
  if (step.value !== undefined) action.value = step.value
  return action
}

/**
 * Familia del paso: qué clase de control se accionó. La calcula el motor, que es
 * quien ve el DOM; aquí solo se lee, con una reserva para los pasos que vienen
 * de un borrador anterior a esta función (donde solo había «campo o no»).
 */
function familyOf(step: RecordedStep): StepFamily | null {
  if (step.family !== undefined) return step.family
  return step.action === 'fill' ||
    step.action === 'select' ||
    (step.action === 'click' && step.isFormField === true)
    ? 'field'
    : null
}

/**
 * Un paso pertenece a un formulario si escribe o selecciona un valor, o si es un
 * clic para enfocar un campo. Así, la secuencia real de rellenar (clic en el
 * campo → escribir → clic en el siguiente → escribir…) se agrupa entera; un clic
 * en un botón la rompe.
 */
function isFormInput(step: RecordedStep): boolean {
  return familyOf(step) === 'field'
}

/**
 * ¿Los dos pasos ocurren en el mismo sitio, a efectos de fundirlos?
 *
 * Fuera de una tabla, el ámbito es la pantalla: dos campos seguidos son el mismo
 * formulario (la URL ya se comprueba aparte). Dentro de una tabla no basta, y la
 * rejilla tiene tres ámbitos que sí significan algo en un manual:
 *
 *  - **la misma celda** y **la misma fila** → un registro que se está editando
 *    en línea («rellenar la fila de Andy»);
 *  - **la misma columna** en filas distintas → la misma acción repetida sobre
 *    varios registros («marcar la casilla de cinco alumnos»), que es un paso y
 *    no cinco.
 *
 * Lo que sigue sin fundirse es lo que de verdad no tiene que ver: dos controles
 * **distintos** de **filas distintas** (la casilla de la fila 1 con el
 * desplegable de la fila 3), dos tablas distintas, y una tabla con lo de fuera.
 */
/**
 * ¿El paso puede sumarse al grupo? Se compara con **todos** sus miembros, no
 * solo con el último.
 *
 * Sin eso, un grupo se podría «arrastrar» fuera de su ámbito paso a paso: dos
 * casillas de la misma columna forman un grupo cuyo primer miembro está en la
 * fila 1, y un control cualquiera de esa fila 1 se colaría dentro aunque no
 * tenga nada que ver con los otros. Exigiendo el ámbito con todos, un grupo de
 * columna solo admite esa columna y uno de fila solo esa fila.
 */
function joinsGroup(last: RecordedStep, step: RecordedStep): boolean {
  return (last.groupSources ?? [last]).every((member) => sameScope(member, step))
}

function sameScope(a: RecordedStep, b: RecordedStep): boolean {
  const rowA = a.rowRef ?? null
  const rowB = b.rowRef ?? null
  if (rowA === null && rowB === null) return true
  if (rowA === null || rowB === null) return false
  if (rowA === rowB) return true
  return (
    a.tableRef != null &&
    a.tableRef === b.tableRef &&
    a.colIndex != null &&
    a.colIndex === b.colIndex
  )
}

/**
 * Añade o actualiza un campo del grupo por etiqueta: el clic para enfocar («…»,
 * sin valor) y la escritura posterior del mismo campo se funden en una sola
 * entrada, y un valor real no lo pisa un clic vacío posterior.
 *
 * Las acciones y las referencias se acumulan siempre, aunque la entrada ya
 * exista: el runner debe reproducir la secuencia real (enfocar y luego escribir)
 * y el resaltado necesita todos los elementos implicados.
 */
function upsertItem(items: GroupedField[], incoming: GroupedField): GroupedField[] {
  const i = items.findIndex((f) => f.label === incoming.label)
  if (i < 0) return [...items, incoming]
  const next = items.slice()
  next[i] = {
    ...next[i],
    value: incoming.value || next[i].value,
    actions: [...next[i].actions, ...incoming.actions],
    refs: [...next[i].refs, ...incoming.refs]
  }
  return next
}

/**
 * Etiqueta con la que un paso se lista dentro de un grupo. Para un campo de
 * formulario basta con su nombre («Correo»), que es como se lee un formulario;
 * para cualquier otro paso —un botón, una fila de tabla— se conserva su título
 * entero («Clic en «Guardar»»), porque ahí el verbo es parte de la información.
 */
function groupLabel(step: RecordedStep): string {
  return isFormInput(step) ? fieldLabel(step) : step.title.trim() || fieldLabel(step)
}

/** «A», «B» y «C» — enumeración legible de los nombres de un grupo. */
function nameList(steps: RecordedStep[]): string | null {
  const names = steps.map((step) => fieldLabel(step))
  // Un elemento sin nombre propio (el título entero como etiqueta) haría una
  // enumeración ilegible; entonces se cae al recuento.
  if (names.some((name, i) => !name || name === steps[i].title)) return null
  const quoted = names.map((name) => `«${name}»`)
  if (quoted.length === 1) return quoted[0]
  return `${quoted.slice(0, -1).join(', ')} y ${quoted[quoted.length - 1]}`
}

/**
 * Título de un paso agrupado.
 *
 * Un grupo se titula por lo que ES, no por un recuento («… y 2 más»), que no
 * dice nada en un manual. Los casos que aparecen de verdad:
 *
 *  - los campos de un formulario → «Rellenar el formulario»;
 *  - la misma columna de una tabla en varias filas → «Marcar «Estado» en 3
 *    filas», que es como se cuenta marcar la casilla de tres registros;
 *  - una fila que se edita en línea → «Rellenar la fila»;
 *  - varias pestañas o varios botones → se enumeran, porque sus nombres son
 *    cortos y son justo la información («Pulsar «Guardar» y «Cerrar»»);
 *  - el caso mixto que se agrupa a mano: un formulario y la acción que lo cierra
 *    → «Rellenar el formulario y pulsar «Guardar»».
 */
function groupTitle(chosen: RecordedStep[]): string {
  const families = new Set(chosen.map(familyOf))
  const family = families.size === 1 ? [...families][0] : null

  if (family === 'tab') {
    const names = nameList(chosen)
    if (names) return `Ir a las pestañas ${names}`
  }
  if (family === 'action') {
    const names = nameList(chosen)
    if (names) return `Pulsar ${names}`
  }
  if (family === 'field') {
    const rows = new Set(chosen.map((step) => step.rowRef ?? null))
    const inTable = !rows.has(null)
    if (inTable && rows.size > 1) {
      // Misma columna, varias filas: el encabezado dice QUÉ se hizo mucho mejor
      // que el nombre de cada control («Seleccionar Andy», «Seleccionar Paulo»…).
      const header = chosen[0].colHeader?.trim()
      const verb = chosen.every((step) => step.action === 'click') ? 'Marcar' : 'Rellenar'
      return header
        ? `${verb} «${header}» en ${rows.size} filas`
        : `${verb} ${rows.size} filas de la tabla`
    }
    return inTable ? 'Rellenar la fila' : 'Rellenar el formulario'
  }

  const fields = chosen.filter(isFormInput)
  const others = chosen.filter((step) => !isFormInput(step))
  if (fields.length && others.length === 1) {
    const label = fieldLabel(others[0])
    // Solo si el elemento tiene nombre propio: «pulsar «<button>»» sería peor que
    // el recuento.
    if (label && label !== others[0].title) return `Rellenar el formulario y pulsar «${label}»`
  }
  const first = chosen[0]
  return `${first.title.trim() || 'Paso'} y ${chosen.length - 1} más`
}

/** Los elementos que aporta un paso al grupo (si ya era un grupo, los suyos). */
function itemsOf(step: RecordedStep): GroupedField[] {
  if (step.groupItems?.length) return step.groupItems
  return [
    {
      label: groupLabel(step),
      value: step.value ?? '',
      actions: step.mergedActions?.length ? step.mergedActions : [toFlowAction(step)],
      refs: step.ref !== undefined ? [step.ref] : []
    }
  ]
}

/**
 * Por qué NO se puede agrupar la selección actual, o `null` si sí se puede. Lo
 * usa el panel para explicar el motivo en vez de dejar un botón apagado sin
 * explicación.
 *
 * Se exige que los pasos sean seguidos porque el grupo se reproduce como una
 * secuencia: fundir el paso 2 con el 7 reordenaría el flujo real y el runner
 * repetiría las acciones en un orden que nunca ocurrió. Para juntarlos, primero
 * se arrastran hasta ponerlos seguidos.
 */
export function selectionProblem(steps: RecordedStep[], selectedIds: string[]): string | null {
  const indexes = steps
    .map((step, index) => (selectedIds.includes(step.id) ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length < 2) return 'Marca al menos dos pasos para agruparlos.'
  if (indexes[indexes.length - 1] - indexes[0] + 1 !== indexes.length) {
    return 'Solo se pueden agrupar pasos seguidos. Arrástralos para ponerlos juntos.'
  }
  const chosen = indexes.map((index) => steps[index])
  if (chosen.some((step) => step.kind && step.kind !== 'interaction')) {
    return 'Las capturas, los bloques de contenido, las secciones y las carpetas no se agrupan: no son acciones del flujo. Para juntar capturas, arrástralas a una carpeta.'
  }
  if (chosen.some((step) => step.groupId)) {
    return 'Hay pasos que están dentro de una carpeta de capturas. Sácalos de ella para poder agruparlos.'
  }
  if (chosen.some((step) => !step.includeInDocs)) {
    return 'Hay pasos excluidos de la documentación entre los marcados.'
  }
  return null
}

/** Referencias de todos los campos del grupo, para resaltarlos en la captura. */
export function groupTargetsOf(step: RecordedStep): GroupTarget[] {
  return (step.groupItems ?? []).map((item) => ({
    refs: item.refs,
    // Los selectores de sus acciones, sin repetir: con ellos el motor vuelve a
    // localizar el elemento cuando el framework ha reemplazado el nodo (guardar
    // el formulario, redibujar la tabla) y la referencia ya no vale.
    selectorCandidates: dedupeSelectors(item.actions.flatMap((a) => a.selectorCandidates ?? []))
  }))
}

function dedupeSelectors(candidates: SelectorCandidate[]): SelectorCandidate[] {
  const seen = new Set<string>()
  const unique: SelectorCandidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.value)) continue
    seen.add(candidate.value)
    unique.push(candidate)
  }
  return unique.sort((a, b) => b.score - a.score)
}

/**
 * Vuelca los campos del grupo sobre el paso: `fields` es lo que se publica en el
 * manual y `mergedActions` lo que reproduce el runner. Se derivan siempre de
 * `groupItems`, para que quitar un campo no deje descuadrada su acción.
 */
function withGroupItems(step: RecordedStep, items: GroupedField[]): RecordedStep {
  return {
    ...step,
    groupItems: items,
    fields: items.map(({ label, value }) => ({ label, value })),
    mergedActions: items.flatMap((item) => item.actions)
  }
}

const THEME_KEY = 'docrecorder.theme'
const HIDE_INTRO_KEY = 'docrecorder.hideDocusaurusIntro'
const ZOOM_KEY = 'docrecorder.viewportZoom'

/**
 * Zoom recordado del visor. Se persiste porque documentar el mismo sistema al
 * 80 % durante una tarde y tener que volver a bajarlo en cada arranque sería un
 * incordio; un valor ilegible vuelve al 100 %.
 */
function initialZoom(): number {
  try {
    return clampZoom(Number(localStorage.getItem(ZOOM_KEY)))
  } catch {
    return DEFAULT_ZOOM
  }
}

/** El aviso inicial se muestra salvo que el usuario haya pedido no verlo más. */
function initialIntroOpen(): boolean {
  try {
    return localStorage.getItem(HIDE_INTRO_KEY) !== '1'
  } catch {
    return true
  }
}

/** Preferencia guardada; si no hay, la del sistema; por defecto, claro. */
function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') return saved
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark'
  } catch {
    // localStorage puede fallar en contextos restringidos; se cae a claro.
  }
  return 'light'
}

/** El paso es una carpeta de capturas (§17). */
function isFolder(step: RecordedStep): boolean {
  return step.kind === 'group'
}

/** El mismo paso, fuera de la carpeta en la que estuviera. */
function withoutGroup(step: RecordedStep): RecordedStep {
  if (step.groupId === undefined) return step
  const next = { ...step }
  delete next.groupId
  return next
}

/**
 * Devuelve la lista con la invariante de las carpetas puesta: cada carpeta va
 * seguida inmediatamente de sus capturas, y nadie apunta a una carpeta que ya no
 * existe.
 *
 * Se aplica en TODA renumeración, que es lo que la convierte en una invariante
 * de verdad: da igual si los pasos vienen de arrastrar, de grabar en medio, de un
 * borrador de ayer o de un commit. Así, el resto del código puede dar por hecho
 * que un bloque es contiguo (dibujarlo, moverlo, publicarlo) sin comprobarlo cada
 * vez. Quitar la carpeta libera sus pasos en lugar de perderlos, igual que quitar
 * una sección conserva los suyos.
 */
function regroup(steps: RecordedStep[]): RecordedStep[] {
  const folders = new Set(steps.filter(isFolder).map((step) => step.id))
  const belongs = (step: RecordedStep): boolean =>
    !isFolder(step) && !!step.groupId && folders.has(step.groupId)

  const members = new Map<string, RecordedStep[]>()
  for (const step of steps) {
    if (!belongs(step)) continue
    const list = members.get(step.groupId as string) ?? []
    list.push(step)
    members.set(step.groupId as string, list)
  }

  const out: RecordedStep[] = []
  for (const step of steps) {
    if (belongs(step)) continue
    // Lo que queda con `groupId` aquí o es huérfano (su carpeta se borró) o es
    // una carpeta que alguien intentó meter en otra: en ambos casos, suelto.
    out.push(step.groupId ? withoutGroup(step) : step)
    if (isFolder(step)) out.push(...(members.get(step.id) ?? []))
  }
  return out
}

/**
 * Renumera la lista. Los separadores de sección no consumen número: son
 * estructura, no pasos, y si contaran el panel mostraría saltos («1, 2, 4») que
 * no se corresponden con nada del manual. Las capturas de una carpeta tampoco:
 * son las ilustraciones del paso que es la carpeta, y el manual las publica
 * dentro de él.
 */
function renumber(steps: RecordedStep[]): RecordedStep[] {
  let n = 0
  return regroup(steps).map((step) =>
    step.kind === 'section' || step.groupId ? { ...step, order: 0 } : { ...step, order: ++n }
  )
}

/**
 * Cuántos pasos cuelgan de la sección que empieza en `index`: todos los que van
 * detrás hasta la sección siguiente (o hasta el final). Es lo que hace que una
 * sección se arrastre con su contenido y se pueda plegar entera.
 */
export function sectionSize(steps: RecordedStep[], index: number): number {
  let end = index + 1
  while (end < steps.length && steps[end].kind !== 'section') end++
  return end - index - 1
}

/** Cuántas capturas contiene la carpeta que empieza en `index`. */
export function groupSize(steps: RecordedStep[], index: number): number {
  const id = steps[index]?.id
  let end = index + 1
  while (end < steps.length && steps[end].groupId === id) end++
  return end - index - 1
}

/**
 * Cuántos pasos se mueven junto al de `index`: una sección se lleva su apartado y
 * una carpeta se lleva sus capturas. Cualquier otro paso viaja solo.
 */
function blockSize(steps: RecordedStep[], index: number): number {
  const step = steps[index]
  if (!step) return 0
  if (step.kind === 'section') return 1 + sectionSize(steps, index)
  if (isFolder(step)) return 1 + groupSize(steps, index)
  return 1
}

/** Despliega la sección que contiene al paso `index`, si estaba plegada. */
function expand(collapsed: string[], steps: RecordedStep[], index: number): string[] {
  const owner = sectionIdAt(steps, index)
  return owner && collapsed.includes(owner) ? collapsed.filter((id) => id !== owner) : collapsed
}

/** Sección a la que pertenece el paso `index`, o `null` si va antes de la primera. */
export function sectionIdAt(steps: RecordedStep[], index: number): string | null {
  for (let i = Math.min(index, steps.length - 1); i >= 0; i--) {
    if (steps[i].kind === 'section') return steps[i].id
  }
  return null
}

export const useSession = create<SessionState>((set) => ({
  sessionId: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  meta: {
    module: '',
    subcategory: '',
    feature: '',
    title: '',
    role: '',
    baseUrl: '',
    aiContext: ''
  },
  viewport: DEFAULT_VIEWPORT,
  outputDir: '',
  status: 'idle',
  attached: false,
  currentUrl: '',
  error: null,
  steps: [],
  focusStepId: null,
  activeStepId: null,
  selectedIds: [],
  collapsedSections: [],
  editing: null,
  gitRepo: null,
  gitEnabled: false,
  gitPush: false,
  gitVerify: initialVerify(),
  docsChecks: null,
  checksRun: null,
  checksReport: null,
  previewUrl: null,
  gitBranchOverride: null,
  gitMessageOverride: null,
  branchDocs: [],
  gitBaseBranch: null,
  branchPickerOpen: false,
  projectsOpen: false,
  wideContentId: null,
  helpOpen: false,
  docusaurusIntroOpen: initialIntroOpen(),
  theme: initialTheme(),
  panelCollapsed: false,
  viewportActive: false,
  viewportZoom: initialZoom(),
  runnerPhase: 'idle',
  runnerProgress: [],
  runnerReport: null,
  groupConsecutive: initialGroupConsecutive(),
  aiStatus: null,
  aiOpen: false,
  aiContextOpen: false,
  pendingDocsOpen: false,
  aiBusyIds: [],
  aiProgress: null,
  aiError: null,

  setMeta: (patch) => set((s) => ({ meta: { ...s.meta, ...patch } })),
  setOutputDir: (outputDir) => set({ outputDir }),

  applyEngineState: (state) =>
    set((s) => ({
      status: state.status,
      attached: state.attached,
      currentUrl: state.url,
      error: state.error ?? null,
      // Una vez adjunto el motor hay página real: el visor debe cubrir el hueco
      // aunque la navegación se haya iniciado por otra vía (historial, recarga).
      viewportActive: s.viewportActive || state.attached
    })),

  addStep: (step) => {
    // Se guarda fuera del `set` porque hay que devolverlo: el orden definitivo
    // solo se conoce tras renumerar, y es el número que llevará el resaltado.
    const result: { merged: RecordedStep | null } = { merged: null }
    set((s) => {
      // Lo grabado entra justo DETRÁS de la tarjeta activa, igual que lo que se
      // añade a mano. Grabando de corrido la activa es siempre la última —cada
      // paso nuevo la mueve—, así que el comportamiento normal no cambia; pero si
      // el usuario se coloca en un paso del medio para completar algo que se le
      // olvidó, lo que grabe entra ahí y no al final de una lista de cincuenta.
      const activeIndex = s.steps.findIndex((existing) => existing.id === s.activeStepId)
      const at = activeIndex >= 0 ? activeIndex + 1 : s.steps.length
      // El vecino de arriba es con quien se puede fundir el campo nuevo (no el
      // último de la lista: insertando en medio, el último no pinta nada).
      const last = s.steps[at - 1]
      // Se funde con el paso anterior si son de la MISMA familia (los campos de
      // un formulario entre sí, las pestañas entre sí, los botones entre sí), en
      // la misma URL y en el mismo ámbito (ver `sameScope`). Cambiar de familia
      // abre paso nuevo: así el «Guardar» de un formulario conserva su tarjeta y
      // el corte del flujo sigue estando donde el lector lo espera. Un envío, una
      // tecla o una navegación no tienen familia y nunca se funden, y tampoco se
      // funde nada dentro de un paso excluido de la documentación.
      const family = familyOf(step)
      const mergeable =
        s.groupConsecutive &&
        family !== null &&
        last &&
        familyOf(last) === family &&
        last.url === step.url &&
        (last.loadRef ?? null) === (step.loadRef ?? null) &&
        last.includeInDocs &&
        joinsGroup(last, step)

      if (mergeable) {
        // La captura pasa a ser la más reciente (el formulario más completo) y el
        // campo se acumula (deduplicado por etiqueta). La primera vez se siembra
        // con el campo del paso anterior.
        // La primera vez el grupo se siembra con el paso anterior, que hasta
        // ahora era un paso suelto.
        const seeded: GroupedField[] = last.groupItems ?? [
          {
            label: fieldLabel(last),
            value: last.value ?? '',
            actions: [toFlowAction(last)],
            refs: last.ref !== undefined ? [last.ref] : []
          }
        ]
        const items = upsertItem(seeded, {
          label: fieldLabel(step),
          value: step.value ?? '',
          actions: [toFlowAction(step)],
          refs: step.ref !== undefined ? [step.ref] : []
        })
        // Los pasos originales se conservan siempre (también al fundir solo), y
        // no únicamente al agrupar a mano: son los que devuelve «⊟ Deshacer», así
        // que ahora una fusión automática también se puede deshacer sin tener que
        // apagar el interruptor y volver a grabar.
        const sources = [...(last.groupSources ?? [last]), step]
        // El título se recalcula solo mientras siga siendo el que generó la app.
        // Si quien documenta ya escribió el suyo —lo normal: el panel enfoca el
        // título de cada paso nuevo—, el campo siguiente no se lo pisa.
        const previousAuto = last.groupSources ? groupTitle(last.groupSources) : last.title
        const merged = withGroupItems(
          {
            ...last,
            // Un grupo de campos se reproduce como un `fill`; una cadena de
            // botones o de pestañas conserva su acción, que es un clic.
            action: family === 'field' ? 'fill' : last.action,
            title: last.title === previousAuto ? groupTitle(sources) : last.title,
            tempFile: step.tempFile,
            boundingRect: step.boundingRect,
            timestamp: step.timestamp,
            value: undefined,
            selectorCandidates: step.selectorCandidates,
            groupSources: sources
          },
          items
        )
        const steps = renumber([...s.steps.slice(0, at - 1), merged, ...s.steps.slice(at)])
        result.merged = steps[at - 1]
        return {
          steps,
          focusStepId: merged.id,
          activeStepId: merged.id,
          collapsedSections: expand(s.collapsedSections, steps, at - 1)
        }
      }

      const next = [...s.steps]
      next.splice(at, 0, step)
      return {
        steps: renumber(next),
        focusStepId: step.id,
        // Grabar mueve el punto de trabajo: lo que se pegue a continuación
        // acompaña a este paso, no al que el usuario tocara hace diez minutos.
        activeStepId: step.id,
        // Si cae dentro de una sección plegada, se despliega: un paso que llega y
        // no se ve parecería que la grabación dejó de funcionar.
        collapsedSections: expand(s.collapsedSections, next, at)
      }
    })
    return result.merged
  },

  applyGroupShot: (id, tempFile) =>
    set((s) => ({
      steps: s.steps.map((step) => (step.id === id ? { ...step, tempFile } : step))
    })),

  removeGroupField: (stepId, label) => {
    const result: { updated: RecordedStep | null } = { updated: null }
    set((s) => {
      const target = s.steps.find((step) => step.id === stepId)
      const items = target?.groupItems
      // Nunca se vacía el grupo: quitar el último campo dejaría un paso que no
      // documenta nada. Para eso está el botón de eliminar el paso entero.
      if (!target || !items || items.length < 2) return {}
      const kept = items.filter((item) => item.label !== label)
      if (kept.length === items.length || !kept.length) return {}
      // Quitar un elemento a mano deja de casar con los pasos originales, así que
      // el grupo pierde la opción de deshacerse: restaurar lo que el usuario
      // acaba de quitar sería justo lo contrario de lo que pidió.
      const base = { ...target }
      delete base.groupSources
      const updated = withGroupItems(base, kept)
      result.updated = updated
      return { steps: s.steps.map((step) => (step.id === stepId ? updated : step)) }
    })
    return result.updated
  },

  // Un paso manual comparte el modelo con los grabados —así viaja por el mismo
  // camino: panel, borrador, MDX y Git— pero sin selector ni acción que
  // reproducir. La URL se anota igual, porque sitúa dónde estaba el usuario.
  addManualStep: ({ kind, title, tempFile, content }) =>
    set((s) => {
      // Trabajando dentro de una carpeta —se acaba de crear, o se está mirando
      // una de sus capturas—, lo que se añade entra DENTRO: es lo que se estaba
      // haciendo. Una sección o una carpeta nueva no, que son estructura y no
      // caben ahí (`regroup` las dejaría fuera igualmente).
      const current = s.steps.find((existing) => existing.id === s.activeStepId)
      const owner =
        kind === 'section' || kind === 'group'
          ? undefined
          : current && isFolder(current)
            ? current.id
            : current?.groupId
      const step: RecordedStep = {
        id: crypto.randomUUID(),
        order: s.steps.length + 1,
        kind,
        action: kind,
        title,
        description: '',
        selectorCandidates: [],
        url: s.currentUrl,
        screenshot: '',
        boundingRect: { x: 0, y: 0, width: 0, height: 0 },
        includeInDocs: true,
        timestamp: new Date().toISOString(),
        tempFile: tempFile ?? '',
        ...(owner ? { groupId: owner } : {}),
        ...(kind === 'content' ? { content: content ?? '' } : {}),
        // Una imagen o una captura también admiten bloque de contenido, pero solo
        // si viene dado: abrir el editor vacío en cada imagen sería estorbo.
        ...(kind !== 'content' && content ? { content } : {})
      }
      // Después de la tarjeta activa; si ya no existe (se eliminó, o se deshizo un
      // grupo), al final, que es lo que el usuario ve al desplazarse. También las
      // secciones: el título de un apartado se pone delante de los pasos que
      // encabeza, así que se marca el paso ANTERIOR al apartado nuevo y se añade.
      const active = s.steps.findIndex((existing) => existing.id === s.activeStepId)
      // Con la carpeta seleccionada, lo añadido va al FINAL de lo que ya guarda:
      // se la está llenando, y colar la captura nueva delante de la primera sería
      // lo contrario de lo que se pidió. Marcando una captura concreta, en cambio,
      // lo nuevo va justo detrás de ella, como en el resto del panel.
      const at =
        active < 0
          ? s.steps.length
          : active + 1 + (isFolder(s.steps[active]) ? groupSize(s.steps, active) : 0)
      const next = [...s.steps]
      next.splice(at, 0, step)
      return {
        steps: renumber(next),
        focusStepId: step.id,
        activeStepId: step.id,
        collapsedSections: expand(s.collapsedSections, next, at)
      }
    }),

  updateStep: (id, patch) =>
    set((s) => ({
      steps: s.steps.map((step) => (step.id === id ? { ...step, ...patch } : step))
    })),

  // Quitar una sección quita SOLO su título: los pasos que colgaban de ella
  // pasan al apartado anterior. Es lo contrario de lo que haría un borrado en
  // cascada, y es lo que se espera de un separador: deshacer la división, no
  // perder media grabación de un clic.
  removeStep: (id) =>
    set((s) => ({
      steps: renumber(s.steps.filter((step) => step.id !== id)),
      selectedIds: s.selectedIds.filter((selected) => selected !== id),
      collapsedSections: s.collapsedSections.filter((section) => section !== id)
    })),

  toggleSection: (id) =>
    set((s) => ({
      collapsedSections: s.collapsedSections.includes(id)
        ? s.collapsedSections.filter((section) => section !== id)
        : [...s.collapsedSections, id]
    })),

  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((selected) => selected !== id)
        : [...s.selectedIds, id]
    })),

  clearSelection: () => set({ selectedIds: [] }),

  removeSelected: () =>
    set((s) => ({
      steps: renumber(s.steps.filter((step) => !s.selectedIds.includes(step.id))),
      selectedIds: []
    })),

  // Agrupar a mano es la respuesta a lo que el motor no puede adivinar: que dos
  // botones, o un selector y su opción, o varias filas de una tabla, son UN paso
  // del manual. El resultado es el mismo tipo de paso agrupado que produce la
  // fusión automática de formularios (mismos `groupItems`, `fields` y
  // `mergedActions`), así que el resto de la app no necesita saber de dónde vino.
  groupSelected: () => {
    const result: { merged: RecordedStep | null } = { merged: null }
    set((s) => {
      if (selectionProblem(s.steps, s.selectedIds)) return {}
      const indexes = s.steps
        .map((step, index) => (s.selectedIds.includes(step.id) ? index : -1))
        .filter((index) => index >= 0)
      const chosen = indexes.map((index) => s.steps[index])
      const first = chosen[0]
      const last = chosen[chosen.length - 1]

      let items: GroupedField[] = []
      for (const step of chosen) {
        for (const item of itemsOf(step)) items = upsertItem(items, item)
      }

      // La captura del grupo es la del ÚLTIMO paso: muestra la pantalla con todo
      // hecho. Los campos se re-señalan después (`useGroupCapture`).
      const merged = withGroupItems(
        {
          ...first,
          action: chosen.every(isFormInput) ? 'fill' : first.action,
          title: groupTitle(chosen),
          tempFile: last.tempFile,
          boundingRect: last.boundingRect,
          timestamp: last.timestamp,
          value: undefined,
          selectorCandidates: last.selectorCandidates,
          // Deshacer devuelve cada paso con SU captura, no una copia de la del
          // grupo: si no, desagrupar empeoraría la documentación.
          groupSources: chosen.flatMap((step) => step.groupSources ?? [step])
        },
        items
      )

      const steps = renumber([
        ...s.steps.slice(0, indexes[0]),
        merged,
        ...s.steps.slice(indexes[indexes.length - 1] + 1)
      ])
      result.merged = steps[indexes[0]]
      return { steps, selectedIds: [], focusStepId: merged.id }
    })
    return result.merged
  },

  ungroupStep: (id) =>
    set((s) => {
      const index = s.steps.findIndex((step) => step.id === id)
      const sources = s.steps[index]?.groupSources
      if (index < 0 || !sources?.length) return {}
      return {
        steps: renumber([...s.steps.slice(0, index), ...sources, ...s.steps.slice(index + 1)]),
        selectedIds: []
      }
    }),

  // Arrastrar una sección la mueve CON sus pasos: es la razón de existir de las
  // secciones —reordenar un apartado entero de doce pasos sin arrastrarlos uno a
  // uno—, y dejar el título viajando solo sería justo lo contrario. Una carpeta
  // de capturas viaja igual, con las suyas dentro.
  reorderSteps: (fromIndex, toIndex) =>
    set((s) => {
      const moved = s.steps[fromIndex]
      if (!moved) return {}
      const size = blockSize(s.steps, fromIndex)
      const block = s.steps.slice(fromIndex, fromIndex + size)
      const rest = [...s.steps.slice(0, fromIndex), ...s.steps.slice(fromIndex + size)]
      // `toIndex` viene referido a la lista ORIGINAL (el paso sobre el que se
      // soltó); al quitar el bloque, todo lo que había detrás se ha corrido.
      const at = toIndex > fromIndex ? Math.max(0, toIndex - size + 1) : toIndex
      rest.splice(at, 0, ...block)
      // Sacar una captura de su carpeta se hace arrastrándola fuera: si al
      // soltarla ya no tiene delante ni su carpeta ni una compañera, deja de
      // pertenecer a ella. Meterla NO se hace así —para eso está la zona de la
      // carpeta—, porque entonces cualquier paso soltado detrás del bloque
      // acabaría dentro sin que nadie lo pidiera.
      if (moved.groupId) {
        const before = rest[at - 1]
        const inside = !!before && (before.id === moved.groupId || before.groupId === moved.groupId)
        if (!inside) rest[at] = withoutGroup(moved)
      }
      return { steps: renumber(rest) }
    }),

  // Meter una captura en la carpeta: va al final de las que ya tenga (`regroup`
  // la recoloca detrás de su carpeta), y la carpeta se despliega si estaba
  // plegada, porque soltar algo que no se ve parecería que no ha pasado nada.
  addToGroup: (stepId, groupId) =>
    set((s) => {
      const step = s.steps.find((existing) => existing.id === stepId)
      const folder = s.steps.find((existing) => existing.id === groupId)
      if (!step || !folder || !isFolder(folder) || step.groupId === groupId) return {}
      // Ni una carpeta dentro de otra ni una sección dentro de una carpeta: una
      // carpeta es un paso del manual, y el manual no numera pasos anidados.
      if (isFolder(step) || step.kind === 'section') return {}
      return {
        steps: renumber(
          s.steps.map((existing) => (existing.id === stepId ? { ...existing, groupId } : existing))
        ),
        activeStepId: stepId,
        selectedIds: s.selectedIds.filter((selected) => selected !== stepId),
        collapsedSections: s.collapsedSections.filter((id) => id !== groupId)
      }
    }),

  // Sacarla con el botón: se queda justo detrás de la carpeta, que es donde el
  // usuario la está mirando, en vez de irse al final de la lista.
  removeFromGroup: (stepId) =>
    set((s) => ({
      steps: renumber(
        s.steps.map((existing) => (existing.id === stepId ? withoutGroup(existing) : existing))
      ),
      activeStepId: stepId
    })),

  clearFocus: () => set({ focusStepId: null }),
  setActiveStep: (activeStepId) => set({ activeStepId }),
  resetSteps: () =>
    set({
      steps: [],
      focusStepId: null,
      activeStepId: null,
      selectedIds: [],
      collapsedSections: [],
      editing: null
    }),

  // Descartar deja la sesión como estaba antes de cargar el commit en lo que se
  // puede: sin pasos y sin funcionalidad. Módulo, subcategoría, rol y URL base se
  // conservan —son de la categoría, no del proceso—, así que se puede seguir
  // trabajando ahí sin volver a escribirlos.
  discardEditing: () =>
    set((s) => ({
      steps: [],
      focusStepId: null,
      activeStepId: null,
      selectedIds: [],
      collapsedSections: [],
      editing: null,
      sessionId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      meta: { ...s.meta, feature: '', title: '' },
      gitMessageOverride: null
    })),

  restoreDraft: (draft) =>
    set({
      sessionId: draft.sessionId,
      createdAt: draft.createdAt,
      meta: draft.meta,
      outputDir: draft.outputDir,
      steps: renumber(draft.steps),
      focusStepId: null,
      activeStepId: null,
      selectedIds: [],
      // Un borrador se retoma con todo a la vista: qué estaba plegado ayer no es
      // información que merezca sobrevivir al cierre de la aplicación.
      collapsedSections: [],
      editing: null,
      gitEnabled: draft.git.enabled,
      gitPush: draft.git.push,
      gitBranchOverride: draft.git.branchOverride,
      gitMessageOverride: draft.git.messageOverride,
      gitBaseBranch: draft.git.baseBranch
    }),

  // Volver a editar algo ya publicado: se pisa la sesión entera con la del
  // commit. Los metadatos vienen de su `session.json` (son los que deciden la
  // carpeta de destino) y la carpeta de salida se ajusta para que el paquete se
  // reescriba donde estaba, en vez de aparecer duplicado en otra rama del árbol.
  loadCommitDoc: (payload, branch) =>
    set((s) => ({
      sessionId: payload.session.id || crypto.randomUUID(),
      createdAt: payload.session.createdAt || new Date().toISOString(),
      meta: {
        ...s.meta,
        module: payload.session.module,
        subcategory: payload.session.subcategory ?? '',
        feature: payload.session.feature,
        title: payload.session.title,
        role: payload.session.role,
        baseUrl: payload.session.baseUrl || s.meta.baseUrl
      },
      outputDir: payload.outputDir,
      steps: renumber(payload.steps),
      focusStepId: null,
      activeStepId: null,
      selectedIds: [],
      collapsedSections: [],
      // El panel lo dice y ofrece cancelarlo: estos pasos no los ha grabado
      // nadie en esta sesión, y sin decirlo la única salida visible sería ■.
      editing: {
        title: payload.session.title || payload.session.feature,
        dir: payload.dir,
        commit: payload.commit,
        branch,
        loadedSteps: payload.steps.length
      },
      // Se documenta sobre la rama de ese commit: guardar en otra dejaría dos
      // versiones del mismo proceso en ramas distintas.
      gitEnabled: true,
      gitBranchOverride: branch,
      // El mensaje se recalcula a partir de los metadatos recién cargados.
      gitMessageOverride: null
    })),

  // Tras guardar una funcionalidad se limpia la lista y se estrena sesión, listo
  // para documentar la siguiente (que irá a su rama). Los metadatos se conservan
  // para que el usuario solo cambie funcionalidad/título.
  startFreshSession: () =>
    set({
      steps: [],
      focusStepId: null,
      activeStepId: null,
      selectedIds: [],
      collapsedSections: [],
      editing: null,
      sessionId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      gitMessageOverride: null
    }),

  // Detectar un repositorio activa la integración por defecto, pero nunca el
  // push: subir cambios al repositorio de otra persona se pide a mano.
  // Cambiar de repositorio invalida las ramas elegidas (la de trabajo y la
  // base): pertenecían al repositorio anterior y aquí pueden no existir.
  //
  // Solo se descartan al pasar de un repositorio a OTRO. Ni al detectar el
  // primero —la elección puede venir de un borrador restaurado, antes de que la
  // inspección termine— ni al quedarse sin repositorio, que también ocurre si la
  // inspección falla de forma pasajera y sería una pérdida gratuita.
  setGitRepo: (gitRepo) =>
    set((s) => {
      const movedToAnother = !!s.gitRepo && !!gitRepo && s.gitRepo.root !== gitRepo.root
      return {
        gitRepo,
        gitEnabled: gitRepo ? s.gitEnabled : false,
        gitBaseBranch: movedToAnother ? null : s.gitBaseBranch,
        gitBranchOverride: movedToAnother ? null : s.gitBranchOverride
      }
    }),
  setGit: (patch) => {
    if (patch.gitVerify !== undefined) {
      try {
        localStorage.setItem(VERIFY_KEY, patch.gitVerify ? '1' : '0')
      } catch {
        // sin persistencia vale para esta sesión
      }
    }
    set(patch)
  },
  setGitBranch: (gitBranchOverride) => set({ gitBranchOverride }),
  setGitMessage: (gitMessageOverride) => set({ gitMessageOverride }),
  setGitBaseBranch: (gitBaseBranch) => set({ gitBaseBranch }),

  // Elegir una rama existente es la forma de «seguir donde lo dejé»: los
  // metadatos con los que se documentó esa rama vienen de su último
  // `session.json`, no de un registro local, así que también sirven si el commit
  // lo hizo otra persona. Solo se rellena lo que está VACÍO: lo que el usuario
  // haya escrito manda siempre. La funcionalidad y el título no se copian: se va
  // a documentar una nueva (para retomar una concreta está `loadBranchDoc`).
  adoptBranch: (branch, doc, enableGit = true) =>
    set((s) => {
      const meta = { ...s.meta }
      if (doc) {
        if (!meta.module.trim()) meta.module = doc.module
        if (!meta.subcategory.trim()) meta.subcategory = doc.subcategory
        if (!meta.role.trim()) meta.role = doc.role
        if (!meta.baseUrl.trim()) meta.baseUrl = doc.baseUrl
      }
      return {
        meta,
        gitBranchOverride: branch,
        // Elegir rama de trabajo es decir que esto va al repositorio; sin esto
        // habría que acordarse de marcar además la casilla del panel.
        gitEnabled: enableGit && s.gitRepo ? true : s.gitEnabled
      }
    }),

  // Aquí sí se pisa todo: se está retomando una funcionalidad concreta (para
  // ampliarla o regrabarla), y sus cuatro campos deben coincidir con los suyos o
  // la documentación acabaría en otra carpeta.
  loadBranchDoc: (doc) =>
    set((s) => ({
      // Ya no se está editando el paquete del commit: el destino es otro.
      editing: null,
      meta: {
        ...s.meta,
        module: doc.module,
        subcategory: doc.subcategory,
        feature: doc.feature,
        title: doc.title,
        role: doc.role,
        baseUrl: doc.baseUrl || s.meta.baseUrl
      },
      // El mensaje sugerido se recalcula a partir de los metadatos nuevos.
      gitMessageOverride: null
    })),

  // Colocar un proceso NUEVO en una categoría/subcategoría ya existente: se fijan
  // módulo y subcategoría, pero se dejan vacíos funcionalidad y título para que el
  // usuario los escriba. Es lo que dispara un nodo del árbol del selector de rama.
  pickCategory: (module, subcategory) =>
    set((s) => ({
      editing: null,
      meta: { ...s.meta, module, subcategory, feature: '', title: '' },
      gitMessageOverride: null
    })),

  setBranchDocs: (branchDocs) => set({ branchDocs }),

  setBranchPickerOpen: (branchPickerOpen) => set({ branchPickerOpen }),
  setProjectsOpen: (projectsOpen) => set({ projectsOpen }),
  setWideContentId: (wideContentId) => set({ wideContentId }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  dismissDocusaurusIntro: (remember) => {
    if (remember) {
      try {
        localStorage.setItem(HIDE_INTRO_KEY, '1')
      } catch {
        // sin persistencia el aviso reaparecerá; no es crítico
      }
    }
    set({ docusaurusIntroOpen: false })
  },
  openDocusaurusIntro: () => set({ docusaurusIntroOpen: true }),
  togglePanel: () => set((s) => ({ panelCollapsed: !s.panelCollapsed })),
  toggleTheme: () =>
    set((s) => {
      const theme = s.theme === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(THEME_KEY, theme)
      } catch {
        // sin persistencia: el cambio vale para esta sesión igualmente
      }
      return { theme }
    }),
  setViewportActive: (viewportActive) => set({ viewportActive }),
  setViewportZoom: (factor) => {
    const viewportZoom = clampZoom(factor)
    try {
      localStorage.setItem(ZOOM_KEY, String(viewportZoom))
    } catch {
      // sin persistencia el zoom vale para esta sesión igualmente
    }
    set({ viewportZoom })
  },
  setGroupConsecutive: (groupConsecutive) => {
    try {
      localStorage.setItem(GROUP_KEY, groupConsecutive ? '1' : '0')
    } catch {
      // sin persistencia vale para esta sesión
    }
    set({ groupConsecutive })
  },

  runnerStart: () => set({ runnerPhase: 'running', runnerProgress: [], runnerReport: null }),
  runnerProgressAdd: (result) => set((s) => ({ runnerProgress: [...s.runnerProgress, result] })),
  runnerFinish: (report) => set({ runnerPhase: 'done', runnerReport: report }),
  runnerClose: () => set({ runnerPhase: 'idle', runnerProgress: [], runnerReport: null }),

  setDocsChecks: (docsChecks) => set({ docsChecks }),

  checksStart: (purpose) =>
    set((s) => ({
      checksReport: null,
      checksRun: {
        purpose,
        label: 'Preparando…',
        index: 0,
        total: s.docsChecks?.checks.length ?? 1,
        lines: []
      }
    })),

  // Solo se conservan las últimas líneas: la salida de una compilación son miles
  // y el diálogo enseña el final, que es donde está el error.
  checksProgress: (progress) =>
    set((s) => {
      if (!s.checksRun) return {}
      const lines = progress.line
        ? [...s.checksRun.lines, progress.line].slice(-CHECK_LINES)
        : s.checksRun.lines
      return {
        checksRun: {
          ...s.checksRun,
          label: progress.label,
          index: progress.index,
          total: progress.total,
          lines
        }
      }
    }),

  checksFinish: (report) =>
    set((s) => ({
      checksRun: null,
      checksReport: report && s.checksRun ? { purpose: s.checksRun.purpose, ...report } : null
    })),

  checksClose: () => set({ checksReport: null }),
  setPreviewUrl: (previewUrl) => set({ previewUrl }),

  setAiStatus: (aiStatus) => set({ aiStatus }),
  setAiOpen: (aiOpen) => set({ aiOpen }),
  setAiContextOpen: (aiContextOpen) => set({ aiContextOpen }),
  setPendingDocsOpen: (pendingDocsOpen) => set({ pendingDocsOpen }),
  setAiBusy: (aiBusyIds) => set({ aiBusyIds }),
  setAiProgress: (aiProgress) => set({ aiProgress }),
  setAiError: (aiError) => set({ aiError }),

  // La propuesta se aplica como si el usuario hubiera escrito: queda editable y
  // el autoguardado del borrador la recoge. Un paso borrado mientras se redactaba
  // simplemente no encuentra destino.
  applyAiDrafts: (drafts) =>
    set((s) => {
      if (!drafts.length) return {}
      const byId = new Map(drafts.map((d) => [d.id, d]))
      return {
        steps: s.steps.map((step) => {
          const draft = byId.get(step.id)
          return draft ? { ...step, title: draft.title, description: draft.description } : step
        })
      }
    })
}))
