import type { RegenReport } from '../../../shared/types'

/**
 * Informe de una regeneración de capturas: cuántos pasos se actualizaron y
 * cuáles fallaron (conservan su captura anterior y hay que revisarlos a mano).
 */
export function RunnerReportModal({
  report,
  onClose
}: {
  report: RegenReport
  onClose: () => void
}): React.JSX.Element {
  const failed = report.results.filter((r) => r.status === 'failed')
  // Los pasos saltados (capturas externas y bloques de contenido) no se cuentan
  // como actualizados: no había nada que regenerar en ellos.
  const skipped = report.results.filter((r) => r.status === 'skipped')
  const ok = report.results.length - failed.length - skipped.length

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog runner-report" onClick={(e) => e.stopPropagation()}>
        <h3>Regeneración de capturas</h3>

        {report.error ? (
          <p className="git-note warn">{report.error}</p>
        ) : (
          <>
            <p>
              <b>{ok}</b> captura(s) actualizada(s)
              {failed.length > 0 ? (
                <>
                  {' '}
                  · <b className="status-pending">{failed.length} paso(s) fallaron</b> y conservan
                  su captura anterior
                </>
              ) : (
                ' · sin fallos'
              )}
              {skipped.length > 0 && ` · ${skipped.length} paso(s) sin captura que regenerar`}.
            </p>
            {report.featureDir && (
              <p className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                {report.featureDir}
              </p>
            )}
            <ul className="runner-results">
              {report.results.map((r) => (
                <li key={r.order} className={r.status}>
                  <span className="runner-badge">
                    {r.status === 'ok' ? '✔' : r.status === 'skipped' ? '–' : '✕'}
                  </span>
                  <span>
                    <b>{r.order}.</b> {r.title || 'Sin título'}
                    {r.detail && <span className="muted"> — {r.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {failed.length > 0 && (
              <p className="muted">
                Revisa los pasos fallidos: probablemente el sistema cambió y hay que volver a
                grabarlos.
              </p>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button className="btn primary" onClick={onClose}>
            Entendido
          </button>
        </div>
      </div>
    </div>
  )
}
