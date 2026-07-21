import { useEffect, useState } from 'react'
import { TopBar } from './components/TopBar'
import { ViewportSlot } from './components/ViewportSlot'
import { StepsPanel } from './components/StepsPanel'
import { ProjectStatus } from './components/ProjectStatus'
import { ProjectsModal } from './components/ProjectsModal'
import { HelpModal } from './components/HelpModal'
import { DocusaurusIntroModal } from './components/DocusaurusIntroModal'
import { RestoreDraftModal } from './components/RestoreDraftModal'
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
  const theme = useSession((s) => s.theme)
  const [draft, setDraft] = useState<DraftPayload | null>(null)

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
    const offStep = ipc.on('recorder:step', addStep)
    void ipc.invoke('engine:get-state').then(applyEngineState)
    return () => {
      offState()
      offStep()
    }
  }, [applyEngineState, addStep])

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
    </div>
  )
}
