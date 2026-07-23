import { useEffect, useState } from 'react'
import type { CommitDocs, DocStep } from '../../../shared/types'
import { ipc } from '../ipc'

/**
 * Vista previa de la documentación registrada en un commit, dentro del
 * explorador. Lee el `session.json` y las capturas directamente de Git (sin
 * checkout ni Docusaurus), para revisar hasta dónde se llegó en esa rama.
 */
export function CommitDocsPreview({
  repoRoot,
  commit,
  subject,
  onClose
}: {
  repoRoot: string
  commit: string
  subject: string
  onClose: () => void
}): React.JSX.Element {
  const [docs, setDocs] = useState<CommitDocs[] | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    void ipc.invoke('git:commit-docs', { repoRoot, commit }).then(setDocs)
  }, [repoRoot, commit])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2>{subject}</h2>
            <span className="muted">commit {commit} · solo lectura</span>
          </div>
          <button onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>

        <div className="preview-body">
          {docs === null && <p className="muted">Leyendo la documentación del commit…</p>}
          {docs?.length === 0 && (
            <p className="muted">Este commit no registra documentación (ningún session.json).</p>
          )}
          {docs?.map((d) => (
            <section key={d.path} className="preview-feature">
              <h3>{d.session.title || d.session.feature}</h3>
              <p className="muted">
                Módulo: {d.session.module}
                {d.session.subcategory ? ` · Subcategoría: ${d.session.subcategory}` : ''}
                {d.session.role ? ` · Rol: ${d.session.role}` : ''} · {d.session.steps.length}{' '}
                paso(s)
              </p>
              <ol className="preview-steps">
                {d.session.steps.map((step) => (
                  <StepPreview
                    key={step.id}
                    repoRoot={repoRoot}
                    commit={commit}
                    sessionPath={d.path}
                    step={step}
                  />
                ))}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

function StepPreview({
  repoRoot,
  commit,
  sessionPath,
  step
}: {
  repoRoot: string
  commit: string
  sessionPath: string
  step: DocStep
}): React.JSX.Element {
  const [img, setImg] = useState<string | null>(null)

  useEffect(() => {
    const imagePath = sessionPath.replace(/session\.json$/, '') + step.screenshot
    void ipc.invoke('git:doc-image', { repoRoot, commit, imagePath }).then(setImg)
  }, [repoRoot, commit, sessionPath, step.screenshot])

  return (
    <li className={step.includeInDocs === false ? 'preview-step excluded' : 'preview-step'}>
      <div className="preview-step-head">
        <b>{step.order}.</b> {step.title || 'Sin título'}
        {step.includeInDocs === false && <em className="muted"> (no incluido en docs)</em>}
      </div>
      {step.description && <p>{step.description}</p>}
      {step.fields?.length ? (
        <ul className="field-list">
          {step.fields.map((f, i) => (
            <li key={i}>
              <span className="field-label">{f.label}:</span> <code>{f.value || '—'}</code>
            </li>
          ))}
        </ul>
      ) : (
        step.value !== undefined && (
          <div className="step-value">
            valor: <code>{step.value}</code>
          </div>
        )
      )}
      {img && <img className="preview-shot" src={img} alt={`Captura del paso ${step.order}`} />}
    </li>
  )
}
