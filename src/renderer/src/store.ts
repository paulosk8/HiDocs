import { create } from 'zustand'
import type { RecordedStep } from '../../shared/ipc-contract'
import {
  DEFAULT_VIEWPORT,
  type GitRepoInfo,
  type EngineState,
  type RecorderStatus,
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

  setMeta: (patch: Partial<SessionMeta>) => void
  setOutputDir: (dir: string) => void
  applyEngineState: (state: EngineState) => void
  addStep: (step: RecordedStep) => void
  updateStep: (id: string, patch: Partial<RecordedStep>) => void
  removeStep: (id: string) => void
  reorderSteps: (fromIndex: number, toIndex: number) => void
  clearFocus: () => void
  resetSteps: () => void

  setGitRepo: (repo: GitRepoInfo | null) => void
  setGit: (patch: Partial<Pick<SessionState, 'gitEnabled' | 'gitPush'>>) => void
  setGitBranch: (value: string | null) => void
  setGitMessage: (value: string | null) => void
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

  setMeta: (patch) => set((s) => ({ meta: { ...s.meta, ...patch } })),
  setOutputDir: (outputDir) => set({ outputDir }),

  applyEngineState: (state) =>
    set({
      status: state.status,
      attached: state.attached,
      currentUrl: state.url,
      error: state.error ?? null
    }),

  addStep: (step) =>
    set((s) => ({
      steps: renumber([...s.steps, step]),
      focusStepId: step.id
    })),

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

  // Detectar un repositorio activa la integración por defecto, pero nunca el
  // push: subir cambios al repositorio de otra persona se pide a mano.
  setGitRepo: (gitRepo) => set((s) => ({ gitRepo, gitEnabled: gitRepo ? s.gitEnabled : false })),
  setGit: (patch) => set(patch),
  setGitBranch: (gitBranchOverride) => set({ gitBranchOverride }),
  setGitMessage: (gitMessageOverride) => set({ gitMessageOverride })
}))
