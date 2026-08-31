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
import { AiContextModal } from './components/AiContextModal'
import { PendingDocsModal } from './components/PendingDocsModal'
import { ipc } from './ipc'
import { useSession } from './store'
import { useRepoInspection } from './useRepoInspection'
import { useDocsChecks } from './useDocsChecks'
import { useDraftAutosave } from './useDraftAutosave'
import { useGroupCapture } from './useGroupCapture'
import type { DraftPayload } from '../../shared/ipc-contract'
import { DEFAULT_ZOOM } from '../../shared/zoom'

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
  const aiContextOpen = useSession((s) => s.aiContextOpen)
  const setAiContextOpen = useSession((s) => s.setAiContextOpen)
  const pendingDocsOpen = useSession((s) => s.pendingDocsOpen)
  const setPendingDocsOpen = useSession((s) => s.setPendingDocsOpen)
  const setAiStatus = useSession((s) => s.setAiStatus)
  const setAiProgress = useSession((s) => s.setAiProgress)
  const setViewportZoom = useSession((s) => s.setViewportZoom)
  const checksProgress = useSession((s) => s.checksProgress)
  const [draft, setDraft] = useState<DraftPayload | null>(null)
  const recaptureGroup = useGroupCapture()

  /**
   * Al fundir un campo en un paso de formulario, la captura que traía era la del
   * campo suelto: solo lo marcaba a él. Se pide otra con todo el grupo marcado,
   * que es lo que el paso documenta de verdad.
   */
  const onStep = useCallback(
    (step: Parameters<typeof addStep>[0]) => {
      recaptureGroup(addStep(step))
    },
    [addStep, recaptureGroup]
  )

  // Mantiene `gitRepo` al día aunque el panel (y su sección Git) esté colapsado.
  useRepoInspection()
  // Y lo mismo con los comandos que el proyecto de destino ofrece comprobar.
  useDocsChecks()
  // Autoguarda el borrador de la grabación en curso.
  useDraftAutosave()

  // El visor arranca con el zoom recordado (§19): la vista nativa la crea el
  // proceso principal siempre al 100 %, así que hay que pedírselo desde aquí,
  // que es donde vive la preferencia.
  useEffect(() => {
    const factor = useSession.getState().viewportZoom
    if (factor !== DEFAULT_ZOOM) void ipc.invoke('viewport:zoom', { action: 'set', factor })
  }, [])

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
    const offChecks = ipc.on('checks:progress', checksProgress)
    // El zoom que se cambia con el teclado o la rueda dentro del visor lo aplica
    // main; la barra se entera por aquí.
    const offZoom = ipc.on('viewport:zoom-changed', setViewportZoom)
    void ipc.invoke('engine:get-state').then(applyEngineState)
    // La configuración de IA vive en el main (con la clave); la GUI solo sabe
    // qué proveedor está activo y si tiene clave.
    void ipc.invoke('ai:status').then(setAiStatus)
    return () => {
      offState()
      offStep()
      offRegen()
      offAi()
      offChecks()
      offZoom()
    }
  }, [
    applyEngineState,
    onStep,
    runnerProgressAdd,
    setAiProgress,
    setAiStatus,
    checksProgress,
    setViewportZoom
  ])

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
      {aiContextOpen && <AiContextModal onClose={() => setAiContextOpen(false)} />}
      {pendingDocsOpen && <PendingDocsModal onClose={() => setPendingDocsOpen(false)} />}
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
