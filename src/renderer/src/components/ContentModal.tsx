import { useEffect } from 'react'
import { ContentEditor } from './ContentEditor'

/**
 * El bloque de contenido a pantalla completa: editor y vista previa en paralelo.
 *
 * El panel de pasos es estrecho a propósito (el visor necesita el ancho), y una
 * tabla de cinco columnas no se edita bien en 400 px. Aquí se ve el código y su
 * resultado a la vez, que es como se corrige una tabla sin ir a ciegas.
 */
export function ContentModal({
  title,
  value,
  onChange,
  onClose,
  onRemove
}: {
  title: string
  value: string
  onChange: (value: string) => void
  onClose: () => void
  /** quita el bloque del paso y cierra; ausente si el paso ES el bloque */
  onRemove?: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog content-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Bloque de contenido{title ? ` · ${title}` : ''}</h3>
        <ContentEditor value={value} onChange={onChange} wide autoFocus onRemove={onRemove} />
        <div className="dialog-actions">
          <button className="btn primary" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    </div>
  )
}
