interface Props {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel?: () => void
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
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
          <button className="btn primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
