import { useCallback } from 'react'
import type { AiStepInput } from '../../shared/ipc-contract'
import { ipc } from './ipc'
import { useSession } from './store'

/**
 * Redacción con IA desde la GUI (§11).
 *
 * Un único punto de entrada para el botón de cada paso y para «redactar todos»:
 * ambos envían la misma petición, con el índice completo del flujo, y solo
 * cambian los pasos que piden redactar.
 */

/** Lo que se le manda al main de un paso; el resto de campos no ayuda a redactar. */
function toInput(step: ReturnType<typeof useSession.getState>['steps'][number]): AiStepInput {
  const input: AiStepInput = {
    id: step.id,
    order: step.order,
    action: step.action,
    kind: step.kind ?? 'interaction',
    title: step.title,
    description: step.description,
    url: step.url,
    // Se manda siempre la ruta: es el main quien decide si adjuntar la imagen,
    // según la configuración, y quien la lee del disco. Un bloque de contenido no
    // tiene captura, y entonces no hay nada que adjuntar.
    screenshot: step.tempFile || undefined
  }
  if (step.value !== undefined) input.value = step.value
  if (step.fields?.length) input.fields = step.fields
  // El cuerpo del bloque es lo único que describe ese paso: sin él, la IA no
  // tendría de qué titular una tabla o un fragmento de código.
  if (step.content?.trim()) input.content = step.content.trim()
  return input
}

export function useAiDraft(): { draft: (ids: string[]) => Promise<void> } {
  const draft = useCallback(async (ids: string[]): Promise<void> => {
    // Se lee el estado en el momento de ejecutar: entre el clic y la respuesta
    // pueden haber llegado pasos nuevos o haberse editado títulos.
    const s = useSession.getState()
    const targets = s.steps.filter((step) => ids.includes(step.id))
    if (!targets.length) return

    s.setAiError(null)
    s.setAiBusy(ids)
    s.setAiProgress({ done: 0, total: targets.length })
    try {
      const result = await ipc.invoke('ai:draft', {
        meta: s.meta,
        outline: s.steps.map((step) => ({ order: step.order, title: step.title })),
        steps: targets.map(toInput),
        // Material pegado por quien documenta; el main lo delimita en el prompt.
        context: s.meta.aiContext?.trim() || undefined
      })
      // El resultado puede traer redacciones Y error a la vez (fallo a mitad):
      // se aplica lo que haya llegado y se avisa igualmente del motivo.
      useSession.getState().applyAiDrafts(result.drafts)
      if (result.error) useSession.getState().setAiError(result.error)
    } catch (err) {
      useSession.getState().setAiError(err instanceof Error ? err.message : String(err))
    } finally {
      const done = useSession.getState()
      done.setAiBusy([])
      done.setAiProgress(null)
    }
  }, [])

  return { draft }
}
