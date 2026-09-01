import { useEffect, useRef } from 'react'
import { ipc } from '../ipc'
import { useSession } from '../store'

interface Props {
  /**
   * Registrar el paquete sin comprobar nada. Lo decide el panel (es quien sabe
   * guardar), y solo se ofrece cuando lo que falló era el paso previo al commit.
   */
  onCommitAnyway: () => void
}

/**
 * La comprobación del sitio, mientras corre y cuando termina mal (§17).
 *
 * Enseña la salida REAL de los comandos, no un «algo ha fallado»: el error de
 * Docusaurus dice el archivo y la línea, y es lo único con lo que se puede
 * arreglar el MDX. Se conservan las últimas líneas, que es donde acaba el error.
 */
export function ChecksModal({ onCommitAnyway }: Props): React.JSX.Element | null {
  const run = useSession((s) => s.checksRun)
  const report = useSession((s) => s.checksReport)
  const close = useSession((s) => s.checksClose)
  const logRef = useRef<HTMLPreElement>(null)

  // La salida se sigue como en una terminal: lo último, a la vista.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run?.lines])

  if (run) {
    const step = Math.min(run.index + 1, run.total)
    return (
      <div className="overlay">
        <div className="dialog checks-dialog">
          <h3>
            {run.purpose === 'preview' ? 'Preparando la vista previa' : 'Comprobando el sitio'}
          </h3>
          <p className="checks-step">
            {step} de {run.total} · {run.label}
          </p>
          <pre className="checks-log" ref={logRef}>
            {run.lines.length ? run.lines.join('\n') : 'Arrancando el comando…'}
          </pre>
          <p className="git-note">
            Se ejecuta en tu proyecto de documentación, igual que si lo lanzaras tú desde una
            terminal. Compilar el sitio tarda.
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => void ipc.invoke('checks:cancel')}>
              Cancelar
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!report) return null

  const failed = report.result?.runs.find((r) => !r.ok)
  const canceled = report.result?.canceled
  // Los comandos del proyecto miran TODA la documentación, así que el error
  // puede no tener nada que ver con la guía recién guardada: una página ajena a
  // medio escribir bloqueaba el commit sin decir que el problema no era tuyo.
  const ajeno = !!failed?.otherFiles?.length && !failed?.ownFiles?.length
  const title = canceled
    ? 'Comprobación cancelada'
    : report.purpose === 'preview'
      ? 'No se pudo abrir la vista previa'
      : ajeno
        ? 'El sitio no compila, pero el problema no es de tu guía'
        : 'El sitio no compila: no se ha registrado nada'

  return (
    <div className="overlay" onClick={close}>
      <div className="dialog checks-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {report.error && <p>{report.error}</p>}
        {failed && (
          <>
            <p>
              Falló <code>npm run {failed.script}</code> ({failed.label}).
            </p>
            {ajeno && (
              <p className="checks-scope">
                Los problemas están en{' '}
                {failed.otherFiles?.length === 1 ? 'otra página' : 'otras páginas'} del sitio, no en
                lo que acabas de guardar:{' '}
                {failed.otherFiles?.slice(0, 3).map((f) => (
                  <code key={f}>{f}</code>
                ))}
                {(failed.otherFiles?.length ?? 0) > 3 &&
                  ` y ${(failed.otherFiles?.length ?? 0) - 3} más`}
                . Puedes registrar tu guía y arreglar eso aparte.
              </p>
            )}
            {!!failed.ownFiles?.length && (
              <p className="checks-scope own">
                Hay {failed.ownFiles.length === 1 ? 'un problema' : 'problemas'} en la guía que
                acabas de guardar:{' '}
                {failed.ownFiles.map((f) => (
                  <code key={f}>{f}</code>
                ))}
                .
              </p>
            )}
            <pre className="checks-log">{failed.output || 'El comando no escribió nada.'}</pre>
          </>
        )}
        {report.purpose === 'commit' && (
          <p className="git-note">
            La documentación SÍ está escrita en el repositorio: corrige lo que dice el error y
            vuelve a pulsar ■, o regístrala igualmente y arréglalo después.
          </p>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={close}>
            {report.purpose === 'commit' ? 'Corregir' : 'Entendido'}
          </button>
          {report.purpose === 'commit' && (
            <button
              className="btn"
              onClick={() => {
                close()
                onCommitAnyway()
              }}
            >
              Registrar de todos modos
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
