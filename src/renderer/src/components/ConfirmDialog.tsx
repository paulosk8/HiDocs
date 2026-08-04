interface Props {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
  /**
   * `danger` para lo que destruye algo (descartar documentación). El botón deja
   * de ser el azul de «continuar» y pasa a leerse como lo que es, que es la única
   * forma de que confirmar a ciegas cueste un poco más.
   */
  tone?: 'primary' | 'danger'
  onConfirm: () => void
  onCancel?: () => void
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = 'primary',
  onConfirm,
  onCancel
}: Props): React.JSX.Element {
  return (
    <div className="overlay" onClick={() => onCancel?.()}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="dialog-actions">
          {onCancel && (
            <button className="btn" onClick={onCancel}>
              {cancelLabel ?? 'Cancelar'}
            </button>
          )}
          <button className={`btn ${tone}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
