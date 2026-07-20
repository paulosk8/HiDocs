import { useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { ViewportSlot } from './components/ViewportSlot'
import { StepsPanel } from './components/StepsPanel'
import { ProjectStatus } from './components/ProjectStatus'
import { ProjectsModal } from './components/ProjectsModal'
import { HelpModal } from './components/HelpModal'
import { DocusaurusIntroModal } from './components/DocusaurusIntroModal'
import { ipc } from './ipc'
import { useSession } from './store'
import { useRepoInspection } from './useRepoInspection'

export function App(): React.JSX.Element {
  const applyEngineState = useSession((s) => s.applyEngineState)
  const addStep = useSession((s) => s.addStep)
  const projectsOpen = useSession((s) => s.projectsOpen)
  const setProjectsOpen = useSession((s) => s.setProjectsOpen)
  const helpOpen = useSession((s) => s.helpOpen)
  const setHelpOpen = useSession((s) => s.setHelpOpen)
  const docusaurusIntroOpen = useSession((s) => s.docusaurusIntroOpen)
  const theme = useSession((s) => s.theme)

  // Mantiene `gitRepo` al día aunque el panel (y su sección Git) esté colapsado.
  useRepoInspection()

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
      {docusaurusIntroOpen && <DocusaurusIntroModal />}
    </div>
  )
}
