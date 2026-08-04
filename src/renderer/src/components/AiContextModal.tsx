import { useEffect, useState } from 'react'
import { useSession } from '../store'

/**
 * Material de referencia para la redacción con IA (§11).
 *
 * Resuelve el límite de redactar solo con la captura: el modelo ve la pantalla,
 * pero no sabe cómo se llaman de verdad los campos, qué valida cada uno ni qué
 * significa un código de la tabla. Aquí se pega lo que haga falta —la tabla de
 * campos, el texto de la especificación, un fragmento de código— y viaja con cada
 * petición de redacción.
 *
 * No se publica en el manual ni entra en `session.json`: es contexto para
 * redactar. Se guarda con el borrador, así que sobrevive a cerrar la app y sigue
 * puesto en la grabación siguiente, que es lo normal cuando se documentan varios
 * procesos del mismo módulo.
 */

/** Mismo tope que aplica el proceso principal al armar el prompt. */
const LIMIT = 12_000

export function AiContextModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const meta = useSession((s) => s.meta)
  const setMeta = useSession((s) => s.setMeta)
  const [text, setText] = useState(meta.aiContext ?? '')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const save = (): void => {
    setMeta({ aiContext: text.trim().slice(0, LIMIT) })
    onClose()
  }

  const excess = text.length - LIMIT

  return (
    <div className="overlay" onClick={onClose}>
      <div className="ai-modal context-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Contexto para la IA</h2>
          <button onClick={onClose} aria-label="Cerrar el contexto para la IA">
            ×
          </button>
        </header>

        <div className="ai-body">
          <p className="ai-intro">
            Pega aquí lo que la IA no puede deducir de la captura: los nombres oficiales de los
            campos, las reglas del proceso, un fragmento de código o el texto de la
            especificación. Se envía como referencia con cada redacción, junto a los pasos.
          </p>

          <textarea
            className="context-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              'Ej.: Carrera → campos: Nombre (obligatorio), Modalidad (En línea / Presencial),\n' +
              'Código SENESCYT (6 dígitos)…\n\nO el código, el SQL o la tabla que describa la pantalla.'
            }
            spellCheck={false}
            autoFocus
          />

          <p className="ai-hint">
            {text.trim().length.toLocaleString('es')} de {LIMIT.toLocaleString('es')} caracteres
            {excess > 0 && (
              <b className="ai-warn">
                {' '}
                · sobran {excess.toLocaleString('es')}: se enviará solo el principio
              </b>
            )}
          </p>
          <p className="ai-hint">
            No se publica en el manual ni se guarda en el paquete: solo se usa para redactar. Se
            conserva con el borrador y sigue puesto en la grabación siguiente.
          </p>
        </div>

        <footer>
          {(meta.aiContext ?? '') !== '' && (
            <button
              className="link"
              onClick={() => {
                setText('')
                setMeta({ aiContext: '' })
              }}
            >
              Quitar el contexto
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save}>
            Guardar contexto
          </button>
        </footer>
      </div>
    </div>
  )
}
