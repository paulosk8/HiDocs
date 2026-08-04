import { useCallback } from 'react'
import type { RecordedStep } from '../../shared/ipc-contract'
import { ipc } from './ipc'
import { groupTargetsOf, useSession } from './store'

/**
 * Rehace la captura de un paso de formulario agrupado marcando TODOS sus campos.
 *
 * Se usa en los dos momentos en que el grupo cambia: al fundir un campo nuevo y
 * al quitar uno. La captura que traía el paso marcaba un solo campo, así que sin
 * esto el manual señalaría uno y describiría varios.
 *
 * Es deliberadamente «dispara y olvida»: la GUI ya se actualizó, y la captura
 * mejorada llega cuando el motor pueda. Si la página cambió y no queda ningún
 * elemento que marcar, el motor devuelve `null` y se conserva la anterior.
 */
export function useGroupCapture(): (step: RecordedStep | null) => void {
  const applyGroupShot = useSession((s) => s.applyGroupShot)

  return useCallback(
    (step) => {
      if (!step) return
      const targets = groupTargetsOf(step)
      if (!targets.length) return
      void ipc
        // La URL del paso: si la pantalla ya es otra, el motor conserva la
        // captura que el paso trae en vez de sustituirla por la de después.
        .invoke('recorder:capture-group', { targets, url: step.url })
        .then((file) => {
          if (file) applyGroupShot(step.id, file)
        })
        .catch(() => undefined)
    },
    [applyGroupShot]
  )
}
