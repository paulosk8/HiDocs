import { useEffect, useState } from 'react'
import { shotUrl, type TrashEntry } from '../../../shared/ipc-contract'
import { useSession } from '../store'

/**
 * La papelera de la guía (§19): lo que se ha quitado del panel y todavía se
 * puede devolver a su sitio.
 *
 * Quitar es de las pocas acciones del panel que no tenían vuelta atrás, y la más
 * cara: un paso grabado se lleva consigo su captura, su selector y lo redactado,
 * y recuperarlo obligaba a repetir el proceso en el sistema real. La franja
 * «Deshacer» cubre el arrepentimiento inmediato; esta ventana cubre el otro, el
 * de dos horas después, cuando ya no queda ni el rastro de qué se quitó.
 *
 * Nada de lo que hay aquí se publica: la papelera vive en la sesión y en el
 * borrador, nunca en el paquete ni en el MDX.
 */

/** Qué icono lleva la entrada, para reconocer de un vistazo qué se quitó. */
function icon(entry: TrashEntry): string {
  if (entry.kind === 'content') return '▦'
  if (entry.kind === 'note') return '📝'
  if (entry.kind === 'field') return '⊞'
  const [step] = entry.steps
  if (entry.steps.length > 1) return '☰'
  if (step.kind === 'section') return '§'
  if (step.kind === 'group') return '📁'
  if (step.kind === 'capture' || step.kind === 'image') return '🖼'
  if (step.kind === 'content') return step.note && step.content === undefined ? '📝' : '▦'
  return '•'
}

/**
 * Cuánto hace que se quitó, en la escala en la que se piensa al arrepentirse.
 * La hora exacta va en el `title`: lo que importa aquí es «ahora mismo» o «esta
 * mañana», no el segundo.
 */
function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return 'hace un momento'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  return new Date(iso).toLocaleDateString('es')
}

/** Capturas que enseña la entrada (las tarjetas quitadas que traen imagen). */
function shots(entry: TrashEntry): string[] {
  return entry.kind === 'steps'
    ? entry.steps.filter((step) => step.tempFile).map((step) => step.tempFile)
    : []
}

export function TrashModal({
  onClose,
  onRestore
}: {
  onClose: () => void
  /** restaurar pasa por el panel: un grupo recuperado necesita rehacer su captura */
  onRestore: (entryId: string) => void
}): React.JSX.Element {
  const trash = useSession((s) => s.trash)
  const steps = useSession((s) => s.steps)
  const dropTrash = useSession((s) => s.dropTrash)
  const clearTrash = useSession((s) => s.clearTrash)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Lo que se quitó DENTRO de una tarjeta solo se puede devolver si la tarjeta
  // sigue ahí. Se dice en la lista en lugar de dejar un botón que no hace nada.
  const orphan = (entry: TrashEntry): boolean =>
    entry.kind !== 'steps' && !steps.some((step) => step.id === entry.stepId)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="ai-modal trash-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Papelera de la guía</h2>
          <button onClick={onClose} aria-label="Cerrar la papelera">
            ×
          </button>
        </header>

        <div className="ai-body">
          <p className="ai-intro">
            Lo que has quitado del panel en esta guía. Restaurar lo devuelve a la posición que
            ocupaba. La papelera se guarda con el borrador —así que sigue aquí mañana— y se vacía
            sola al guardar la guía y empezar la siguiente.
          </p>

          {trash.length === 0 && (
            <p className="muted">
              No has quitado nada de esta guía. Aquí no hay nada que recuperar.
            </p>
          )}

          <ul className="trash-list">
            {trash.map((entry) => (
              <li key={entry.id} className={orphan(entry) ? 'trash-orphan' : undefined}>
                <div className="trash-head">
                  <span className="trash-icon" aria-hidden="true">
                    {icon(entry)}
                  </span>
                  <b>{entry.label}</b>
                  <span className="muted" title={new Date(entry.at).toLocaleString('es')}>
                    {ago(entry.at)}
                  </span>
                </div>

                {entry.kind === 'content' && (
                  <code className="trash-preview">{entry.content.slice(0, 200)}</code>
                )}
                {entry.kind === 'note' && (
                  <code className="trash-preview">
                    {entry.note.title ? `${entry.note.title}: ` : ''}
                    {entry.note.body.slice(0, 200)}
                  </code>
                )}
                {shots(entry).length > 0 && (
                  <div className="trash-shots">
                    {shots(entry)
                      .slice(0, 4)
                      .map((file) => (
                        <img key={file} src={shotUrl(file)} alt="" />
                      ))}
                  </div>
                )}

                <div className="trash-actions">
                  <button
                    className="btn primary"
                    disabled={orphan(entry)}
                    title={
                      orphan(entry)
                        ? 'El paso al que pertenecía ya no está en la guía'
                        : 'Devolverlo a la guía, en el sitio que ocupaba'
                    }
                    onClick={() => onRestore(entry.id)}
                  >
                    Restaurar
                  </button>
                  {orphan(entry) && <span className="muted">su paso ya no está en la guía</span>}
                  <button
                    className="btn danger"
                    title="Olvidar esta entrada: dejará de poder recuperarse"
                    onClick={() => dropTrash(entry.id)}
                  >
                    Olvidar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <footer>
          {/* La confirmación es EN LÍNEA, no un diálogo encima del diálogo: el
              visor nativo se pinta sobre el HTML y una segunda superposición
              tendría que volver a negociar quién lo oculta. */}
          {confirmClear ? (
            <span className="trash-confirm">
              ¿Vaciar la papelera? Sus {trash.length} entrada(s) dejarán de poder recuperarse.
              <button
                className="btn danger"
                onClick={() => {
                  clearTrash()
                  setConfirmClear(false)
                }}
              >
                Vaciar
              </button>
              <button className="btn" onClick={() => setConfirmClear(false)}>
                Cancelar
              </button>
            </span>
          ) : (
            <button
              className="btn danger"
              disabled={trash.length === 0}
              onClick={() => setConfirmClear(true)}
            >
              Vaciar la papelera
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  )
}
