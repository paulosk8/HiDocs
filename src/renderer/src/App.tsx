import { useEffect } from 'react'
import { TopBar } from './components/TopBar'
import { ViewportSlot } from './components/ViewportSlot'
import { StepsPanel } from './components/StepsPanel'
import { ipc } from './ipc'
import { useSession } from './store'

export function App(): React.JSX.Element {
  const applyEngineState = useSession((s) => s.applyEngineState)
  const addStep = useSession((s) => s.addStep)
  const attached = useSession((s) => s.attached)

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
    </div>
  )
}
