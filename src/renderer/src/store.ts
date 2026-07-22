import { create } from 'zustand'
import type { DraftPayload, GroupedField, RecordedStep } from '../../shared/ipc-contract'
import {
  DEFAULT_VIEWPORT,
  type AiStatus,
  type AiStepDraft,
  type BranchDocInfo,
  type FlowAction,
  type GitRepoInfo,
  type EngineState,
  type RecorderStatus,
  type RegenReport,
  type RegenStepResult,
  type SessionMeta,
  type Viewport
} from '../../shared/types'

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

  /** repositorio que contiene la carpeta de salida, o null si no hay ninguno */
  gitRepo: GitRepoInfo | null
  gitEnabled: boolean
  gitPush: boolean
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
   * Rama desde la que nacerá la rama de documentación, elegida en el explorador.
   * `null` = usar la rama por defecto del repositorio, que es lo correcto salvo
   * que se quiera continuar una línea de documentación ya empezada.
   */
  gitBaseBranch: string | null
  /** el selector de rama de trabajo (franja de estado) está desplegado */
  branchPickerOpen: boolean
  /** el explorador de repositorios está abierto */
  projectsOpen: boolean
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
  /** estado del runner de regeneración de capturas */
  runnerPhase: 'idle' | 'running' | 'done'
  /** resultados por paso, según van llegando */
  runnerProgress: RegenStepResult[]
  /** informe final de la regeneración */
  runnerReport: RegenReport | null
  /**
   * Agrupar los `fill`/`select` seguidos de un mismo formulario en un solo paso,
   * para no generar una captura por cada campo. Preferencia persistida.
   */
  groupFormFields: boolean

  /**
   * Configuración de IA, tal como la conoce el main. `null` mientras no ha
   * llegado; la clave nunca está aquí, solo si existe o no.
   */
  aiStatus: AiStatus | null
  /** los ajustes de IA están abiertos */
  aiOpen: boolean
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
  updateStep: (id: string, patch: Partial<RecordedStep>) => void
  removeStep: (id: string) => void
  reorderSteps: (fromIndex: number, toIndex: number) => void
  clearFocus: () => void
  resetSteps: () => void
  /** carga un borrador guardado para continuar donde se dejó */
  restoreDraft: (draft: DraftPayload) => void
  /** deja la sesión lista para documentar una funcionalidad nueva (tras guardar) */
  startFreshSession: () => void

  setGitRepo: (repo: GitRepoInfo | null) => void
  setGit: (patch: Partial<Pick<SessionState, 'gitEnabled' | 'gitPush'>>) => void
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
  setBranchPickerOpen: (open: boolean) => void
  setProjectsOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  /** cierra el aviso inicial; si `remember`, no se vuelve a mostrar */
  dismissDocusaurusIntro: (remember: boolean) => void
  /** reabre el aviso inicial (desde la ayuda) */
  openDocusaurusIntro: () => void
  togglePanel: () => void
  toggleTheme: () => void
  setViewportActive: (active: boolean) => void
  setGroupFormFields: (value: boolean) => void
  runnerStart: () => void
  runnerProgressAdd: (result: RegenStepResult) => void
  runnerFinish: (report: RegenReport) => void
  runnerClose: () => void

  setAiStatus: (status: AiStatus) => void
  setAiOpen: (open: boolean) => void
  setAiBusy: (ids: string[]) => void
  setAiProgress: (progress: { done: number; total: number } | null) => void
  setAiError: (message: string | null) => void
  /** vuelca las redacciones propuestas sobre sus pasos */
  applyAiDrafts: (drafts: AiStepDraft[]) => void
}

const GROUP_FIELDS_KEY = 'docrecorder.groupFormFields'

/** Agrupar campos está activado salvo que el usuario lo haya desactivado. */
function initialGroupFormFields(): boolean {
  try {
    return localStorage.getItem(GROUP_FIELDS_KEY) !== '0'
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
 * Un paso pertenece a un formulario si escribe o selecciona un valor, o si es un
 * clic para enfocar un campo. Así, la secuencia real de rellenar (clic en el
 * campo → escribir → clic en el siguiente → escribir…) se agrupa entera; un clic
 * en un botón la rompe.
 */
function isFormInput(step: RecordedStep): boolean {
  return (
    step.action === 'fill' ||
    step.action === 'select' ||
    (step.action === 'click' && step.isFormField === true)
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

/** Referencias de todos los campos del grupo, para resaltarlos en la captura. */
export function groupRefsOf(step: RecordedStep): number[] {
  return (step.groupItems ?? []).flatMap((item) => item.refs)
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

function renumber(steps: RecordedStep[]): RecordedStep[] {
  return steps.map((step, index) => ({ ...step, order: index + 1 }))
}

export const useSession = create<SessionState>((set) => ({
  sessionId: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  meta: { module: '', feature: '', title: '', role: '', baseUrl: '' },
  viewport: DEFAULT_VIEWPORT,
  outputDir: '',
  status: 'idle',
  attached: false,
  currentUrl: '',
  error: null,
  steps: [],
  focusStepId: null,
  gitRepo: null,
  gitEnabled: false,
  gitPush: false,
  gitBranchOverride: null,
  gitMessageOverride: null,
  gitBaseBranch: null,
  branchPickerOpen: false,
  projectsOpen: false,
  helpOpen: false,
  docusaurusIntroOpen: initialIntroOpen(),
  theme: initialTheme(),
  panelCollapsed: false,
  viewportActive: false,
  runnerPhase: 'idle',
  runnerProgress: [],
  runnerReport: null,
  groupFormFields: initialGroupFormFields(),
  aiStatus: null,
  aiOpen: false,
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
      const last = s.steps[s.steps.length - 1]
      // Se funde con el paso anterior si ambos son campos del MISMO formulario
      // (escribir, seleccionar o enfocar un campo con un clic), en la misma URL.
      // Un clic en un botón, un envío o una navegación rompe la secuencia. No se
      // funde dentro de un paso excluido de docs.
      //
      // Y nunca a través de filas de una tabla: marcar la casilla de dos
      // usuarios distintos son dos acciones sobre dos registros, no un
      // formulario que se rellena. Fundirlas producía un paso «Rellenar el
      // formulario» que mezclaba filas y no describía nada.
      const mergeable =
        s.groupFormFields &&
        isFormInput(step) &&
        last &&
        isFormInput(last) &&
        last.url === step.url &&
        last.includeInDocs &&
        (last.rowRef ?? null) === (step.rowRef ?? null)

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
        const merged = withGroupItems(
          {
            ...last,
            action: 'fill',
            title: last.groupItems ? last.title : 'Rellenar el formulario',
            tempFile: step.tempFile,
            boundingRect: step.boundingRect,
            timestamp: step.timestamp,
            value: undefined,
            selectorCandidates: step.selectorCandidates
          },
          items
        )
        const steps = renumber([...s.steps.slice(0, -1), merged])
        result.merged = steps[steps.length - 1]
        return { steps, focusStepId: merged.id }
      }

      return {
        steps: renumber([...s.steps, step]),
        focusStepId: step.id
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
      const updated = withGroupItems(target, kept)
      result.updated = updated
      return { steps: s.steps.map((step) => (step.id === stepId ? updated : step)) }
    })
    return result.updated
  },

  updateStep: (id, patch) =>
    set((s) => ({
      steps: s.steps.map((step) => (step.id === id ? { ...step, ...patch } : step))
    })),

  removeStep: (id) => set((s) => ({ steps: renumber(s.steps.filter((step) => step.id !== id)) })),

  reorderSteps: (fromIndex, toIndex) =>
    set((s) => {
      const next = [...s.steps]
      const [moved] = next.splice(fromIndex, 1)
      if (!moved) return {}
      next.splice(toIndex, 0, moved)
      return { steps: renumber(next) }
    }),

  clearFocus: () => set({ focusStepId: null }),
  resetSteps: () => set({ steps: [], focusStepId: null }),

  restoreDraft: (draft) =>
    set({
      sessionId: draft.sessionId,
      createdAt: draft.createdAt,
      meta: draft.meta,
      outputDir: draft.outputDir,
      steps: renumber(draft.steps),
      focusStepId: null,
      gitEnabled: draft.git.enabled,
      gitPush: draft.git.push,
      gitBranchOverride: draft.git.branchOverride,
      gitMessageOverride: draft.git.messageOverride,
      gitBaseBranch: draft.git.baseBranch
    }),

  // Tras guardar una funcionalidad se limpia la lista y se estrena sesión, listo
  // para documentar la siguiente (que irá a su rama). Los metadatos se conservan
  // para que el usuario solo cambie funcionalidad/título.
  startFreshSession: () =>
    set({
      steps: [],
      focusStepId: null,
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
  setGit: (patch) => set(patch),
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
      meta: {
        ...s.meta,
        module: doc.module,
        feature: doc.feature,
        title: doc.title,
        role: doc.role,
        baseUrl: doc.baseUrl || s.meta.baseUrl
      },
      // El mensaje sugerido se recalcula a partir de los metadatos nuevos.
      gitMessageOverride: null
    })),

  setBranchPickerOpen: (branchPickerOpen) => set({ branchPickerOpen }),
  setProjectsOpen: (projectsOpen) => set({ projectsOpen }),
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
  setGroupFormFields: (groupFormFields) => {
    try {
      localStorage.setItem(GROUP_FIELDS_KEY, groupFormFields ? '1' : '0')
    } catch {
      // sin persistencia vale para esta sesión
    }
    set({ groupFormFields })
  },

  runnerStart: () => set({ runnerPhase: 'running', runnerProgress: [], runnerReport: null }),
  runnerProgressAdd: (result) => set((s) => ({ runnerProgress: [...s.runnerProgress, result] })),
  runnerFinish: (report) => set({ runnerPhase: 'done', runnerReport: report }),
  runnerClose: () => set({ runnerPhase: 'idle', runnerProgress: [], runnerReport: null }),

  setAiStatus: (aiStatus) => set({ aiStatus }),
  setAiOpen: (aiOpen) => set({ aiOpen }),
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
