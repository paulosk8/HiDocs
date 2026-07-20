import { useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { ViewportSlot } from './components/ViewportSlot'
import { StepsPanel } from './components/StepsPanel'
import { ProjectStatus } from './components/ProjectStatus'
import { ProjectsModal } from './components/ProjectsModal'
import { ipc } from './ipc'
import { useSession } from './store'
import { useRepoInspection } from './useRepoInspection'

export function App(): React.JSX.Element {
  const applyEngineState = useSession((s) => s.applyEngineState)
  const addStep = useSession((s) => s.addStep)
  const attached = useSession((s) => s.attached)
  const projectsOpen = useSession((s) => s.projectsOpen)
  const setProjectsOpen = useSession((s) => s.setProjectsOpen)

  // Mantiene `gitRepo` al día aunque el panel (y su sección Git) esté colapsado.
  useRepoInspection()

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
        <ViewportSlot
          hint={
            attached
              ? 'Cargando…'
              : 'Escribe la URL del sistema arriba y pulsa «Abrir». Puedes iniciar sesión normalmente: la sesión se conserva entre usos.'
          }
        />
        <StepsPanel />
      </main>
      {projectsOpen && <ProjectsModal onClose={() => setProjectsOpen(false)} />}
    </div>
  )
}
