import { useEffect } from 'react'
import { shotUrl, type RecordedStep } from '../../../shared/ipc-contract'

interface Props {
  step: RecordedStep
  onClose: () => void
}

/** Captura a tamaño real. Se cierra con clic fuera o con Escape. */
export function ShotModal({ step, onClose }: Props): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <figure className="shot-modal" onClick={(e) => e.stopPropagation()}>
        <img src={shotUrl(step.tempFile)} alt={`Captura del paso ${step.order}`} />
        <figcaption>
          <b>{step.order}.</b> {step.title || 'Sin título'}
        </figcaption>
      </figure>
    </div>
  )
}
