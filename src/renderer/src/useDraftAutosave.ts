import { useEffect, useRef } from 'react'
import { ipc } from './ipc'
import { useSession } from './store'

/**
 * Autoguarda el borrador de la grabación en curso, para poder cerrar la app y
 * continuar otro día. Se guarda con retardo tras cada cambio relevante (pasos,
 * metadatos, carpeta o configuración de Git), no en cada tecla.
 *
 * El borrador se descarta al guardar con éxito (StepsPanel), y como al guardar
 * la sesión se estrena vacía, un guardado pendiente que llegue después no
 * vuelve a crearlo.
 */
export function useDraftAutosave(): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const schedule = (): void => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const s = useSession.getState()
        if (!s.steps.length) return
        void ipc.invoke('draft:save', {
          meta: s.meta,
          steps: s.steps,
          sessionId: s.sessionId,
          createdAt: s.createdAt,
          outputDir: s.outputDir,
          git: {
            enabled: s.gitEnabled,
            push: s.gitPush,
            branchOverride: s.gitBranchOverride,
            messageOverride: s.gitMessageOverride,
            baseBranch: s.gitBaseBranch
          },
          savedAt: new Date().toISOString()
        })
      }, 800)
    }

    const unsub = useSession.subscribe((s, prev) => {
      if (
        s.steps !== prev.steps ||
        s.meta !== prev.meta ||
        s.outputDir !== prev.outputDir ||
        s.gitEnabled !== prev.gitEnabled ||
        s.gitPush !== prev.gitPush ||
        s.gitBranchOverride !== prev.gitBranchOverride ||
        s.gitMessageOverride !== prev.gitMessageOverride ||
        s.gitBaseBranch !== prev.gitBaseBranch
      ) {
        schedule()
      }
    })

    return () => {
      unsub()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
}
