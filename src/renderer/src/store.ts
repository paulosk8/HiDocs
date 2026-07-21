import { create } from 'zustand'
import type { DraftPayload, RecordedStep } from '../../shared/ipc-contract'
import {
  DEFAULT_VIEWPORT,
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
  /** null = usar el nombre sugerido a partir de los metadatos de la sesión */
  gitBranchOverride: string | null
  gitMessageOverride: string | null
  /**
   * Rama desde la que nacerá la rama de documentación, elegida en el explorador.
   * `null` = usar la rama por defecto del repositorio, que es lo correcto salvo
   * que se quiera continuar una línea de documentación ya empezada.
   */
  gitBaseBranch: string | null
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

  setMeta: (patch: Partial<SessionMeta>) => void
  setOutputDir: (dir: string) => void
  applyEngineState: (state: EngineState) => void
  addStep: (step: RecordedStep) => void
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
 * Añade o actualiza un campo por etiqueta: el clic para enfocar («…», sin valor)
 * y la escritura posterior del mismo campo se funden en una sola entrada, y un
 * valor real no lo pisa un clic vacío posterior.
 */
function upsertField(
  fields: Array<{ label: string; value: string }>,
  label: string,
  value: string
): Array<{ label: string; value: string }> {
  const i = fields.findIndex((f) => f.label === label)
  if (i < 0) return [...fields, { label, value }]
  if (!value) return fields
  const next = fields.slice()
  next[i] = { label, value }
  return next
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

  addStep: (step) =>
    set((s) => {
      const last = s.steps[s.steps.length - 1]
      // Se funde con el paso anterior si ambos son campos del MISMO formulario
      // (escribir, seleccionar o enfocar un campo con un clic), en la misma URL.
      // Un clic en un botón, un envío o una navegación rompe la secuencia. No se
      // funde dentro de un paso excluido de docs.
      const mergeable =
        s.groupFormFields &&
        isFormInput(step) &&
        last &&
        isFormInput(last) &&
        last.url === step.url &&
        last.includeInDocs

      if (mergeable) {
        // La captura pasa a ser la más reciente (el formulario más completo) y el
        // campo se acumula (deduplicado por etiqueta). La primera vez se siembra
        // con el campo del paso anterior.
        const seeded = last.fields ?? [{ label: fieldLabel(last), value: last.value ?? '' }]
        const seededActions = last.mergedActions ?? [toFlowAction(last)]
        const merged: RecordedStep = {
          ...last,
          action: 'fill',
          title: last.fields ? last.title : 'Rellenar el formulario',
          tempFile: step.tempFile,
          boundingRect: step.boundingRect,
          timestamp: step.timestamp,
          value: undefined,
          fields: upsertField(seeded, fieldLabel(step), step.value ?? ''),
          // Cada campo se conserva como acción individual para el runner (replay).
          mergedActions: [...seededActions, toFlowAction(step)],
          selectorCandidates: step.selectorCandidates
        }
        return {
          steps: renumber([...s.steps.slice(0, -1), merged]),
          focusStepId: merged.id
        }
      }

      return {
        steps: renumber([...s.steps, step]),
        focusStepId: step.id
      }
    }),

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
  // Cambiar de repositorio invalida la base elegida: esa rama pertenecía al
  // repositorio anterior y aquí puede no existir.
  setGitRepo: (gitRepo) =>
    set((s) => ({
      gitRepo,
      gitEnabled: gitRepo ? s.gitEnabled : false,
      gitBaseBranch: gitRepo?.root === s.gitRepo?.root ? s.gitBaseBranch : null
    })),
  setGit: (patch) => set(patch),
  setGitBranch: (gitBranchOverride) => set({ gitBranchOverride }),
  setGitMessage: (gitMessageOverride) => set({ gitMessageOverride }),
  setGitBaseBranch: (gitBaseBranch) => set({ gitBaseBranch }),
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
  runnerClose: () => set({ runnerPhase: 'idle', runnerProgress: [], runnerReport: null })
}))
