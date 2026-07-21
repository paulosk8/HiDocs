import { useCallback, useEffect, useState } from 'react'
import { TopBar } from './components/TopBar'
import { ViewportSlot } from './components/ViewportSlot'
import { StepsPanel } from './components/StepsPanel'
import { ProjectStatus } from './components/ProjectStatus'
import { ProjectsModal } from './components/ProjectsModal'
import { HelpModal } from './components/HelpModal'
import { DocusaurusIntroModal } from './components/DocusaurusIntroModal'
import { RestoreDraftModal } from './components/RestoreDraftModal'
import { RunnerReportModal } from './components/RunnerReportModal'
import { AiSettingsModal } from './components/AiSettingsModal'
import { ipc } from './ipc'
import { useSession } from './store'
import { useRepoInspection } from './useRepoInspection'
import { useDraftAutosave } from './useDraftAutosave'
import type { DraftPayload } from '../../shared/ipc-contract'

export function App(): React.JSX.Element {
  const applyEngineState = useSession((s) => s.applyEngineState)
  const addStep = useSession((s) => s.addStep)
  const restoreDraft = useSession((s) => s.restoreDraft)
  const projectsOpen = useSession((s) => s.projectsOpen)
  const setProjectsOpen = useSession((s) => s.setProjectsOpen)
  const helpOpen = useSession((s) => s.helpOpen)
  const setHelpOpen = useSession((s) => s.setHelpOpen)
  const docusaurusIntroOpen = useSession((s) => s.docusaurusIntroOpen)
  const runnerPhase = useSession((s) => s.runnerPhase)
  const runnerReport = useSession((s) => s.runnerReport)
  const runnerProgressAdd = useSession((s) => s.runnerProgressAdd)
  const runnerClose = useSession((s) => s.runnerClose)
  const theme = useSession((s) => s.theme)
  const aiOpen = useSession((s) => s.aiOpen)
  const setAiOpen = useSession((s) => s.setAiOpen)
  const setAiStatus = useSession((s) => s.setAiStatus)
  const setAiProgress = useSession((s) => s.setAiProgress)
  const applyGroupShot = useSession((s) => s.applyGroupShot)
  const [draft, setDraft] = useState<DraftPayload | null>(null)

  /**
   * Cuando un campo se funde en un paso de formulario, la captura que traía era
   * la del campo suelto: solo lo marcaba a él. Se pide otra al motor marcando
   * todos los campos del grupo, que es lo que el paso documenta de verdad.
   *
   * Va después de fundir, no antes: la GUI se actualiza al instante y la
   * captura mejorada llega cuando esté. Si la página ya cambió y no se puede
   * marcar nada, el motor devuelve null y se conserva la captura anterior.
   */
  const onStep = useCallback(
    (step: Parameters<typeof addStep>[0]) => {
      const merged = addStep(step)
      if (!merged?.groupRefs || merged.groupRefs.length < 2) return
      void ipc
        .invoke('recorder:capture-group', { refs: merged.groupRefs, badge: merged.order })
        .then((file) => {
          if (file) applyGroupShot(merged.id, file)
        })
        .catch(() => undefined)
    },
    [addStep, applyGroupShot]
  )

  // Mantiene `gitRepo` al día aunque el panel (y su sección Git) esté colapsado.
  useRepoInspection()
  // Autoguarda el borrador de la grabación en curso.
  useDraftAutosave()

  // Al arrancar, ofrece continuar un borrador sin terminar (si lo hay).
  useEffect(() => {
    void ipc.invoke('draft:load').then((d) => {
      if (d) setDraft(d)
    })
  }, [])

  // El tema vive en <html data-theme>, donde el CSS lo lee. No afecta a la vista
  // nativa: esa es la página externa que se documenta, con su propio tema.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const offState = ipc.on('engine:state', applyEngineState)
    const offStep = ipc.on('recorder:step', onStep)
    const offRegen = ipc.on('runner:progress', runnerProgressAdd)
    const offAi = ipc.on('ai:progress', setAiProgress)
    void ipc.invoke('engine:get-state').then(applyEngineState)
    // La configuración de IA vive en el main (con la clave); la GUI solo sabe
    // qué proveedor está activo y si tiene clave.
    void ipc.invoke('ai:status').then(setAiStatus)
    return () => {
      offState()
      offStep()
      offRegen()
      offAi()
    }
  }, [applyEngineState, onStep, runnerProgressAdd, setAiProgress, setAiStatus])

  return (
    <div className="app">
      <TopBar />
      <ProjectStatus />
      <main className="workspace">
        <ViewportSlot />
        <StepsPanel />
      </main>
      {projectsOpen && <ProjectsModal onClose={() => setProjectsOpen(false)} />}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {aiOpen && <AiSettingsModal onClose={() => setAiOpen(false)} />}
      {/* El aviso inicial de Docusaurus espera a resolver antes un borrador. */}
      {docusaurusIntroOpen && !draft && <DocusaurusIntroModal />}
      {draft && (
        <RestoreDraftModal
          draft={draft}
          onContinue={() => {
            restoreDraft(draft)
            setDraft(null)
          }}
          onDiscard={() => {
            void ipc.invoke('draft:clear')
            setDraft(null)
          }}
        />
      )}
      {runnerPhase === 'done' && runnerReport && (
        <RunnerReportModal report={runnerReport} onClose={runnerClose} />
      )}
    </div>
  )
}
