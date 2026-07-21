import type { DraftPayload } from '../../../shared/ipc-contract'

/**
 * Aviso al arrancar cuando hay una grabación sin terminar guardada como
 * borrador. Deja continuar donde se dejó o descartarla.
 */
export function RestoreDraftModal({
  draft,
  onContinue,
  onDiscard
}: {
  draft: DraftPayload
  onContinue: () => void
  onDiscard: () => void
}): React.JSX.Element {
  const when = draft.savedAt ? new Date(draft.savedAt) : null
  const fecha = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : null
  const que = [draft.meta.module, draft.meta.feature].filter(Boolean).join(' · ')

  return (
    <div className="overlay">
      <div className="dialog">
        <h3>Continuar la grabación sin terminar</h3>
        <p>
          Tienes una grabación sin guardar
          {que ? ` de «${que}»` : ''} con <b>{draft.steps.length} paso(s)</b>
          {fecha ? `, del ${fecha}` : ''}. ¿Quieres continuar donde lo dejaste?
        </p>
        <div className="dialog-actions">
          <button className="btn" onClick={onDiscard}>
            Descartar
          </button>
          <button className="btn primary" onClick={onContinue}>
            Continuar
          </button>
        </div>
      </div>
    </div>
  )
}
