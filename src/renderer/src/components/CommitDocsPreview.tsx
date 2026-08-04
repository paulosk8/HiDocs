import { useEffect, useState } from 'react'
import type { CommitDocs, DocStep } from '../../../shared/types'
import { ipc } from '../ipc'
import { useSession } from '../store'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * Vista previa de la documentación registrada en un commit, dentro del
 * explorador. Lee el `session.json` y las capturas directamente de Git (sin
 * checkout ni Docusaurus), para revisar hasta dónde se llegó en esa rama.
 *
 * Y, desde aquí, **retomarla**: revisar suele terminar en «esto hay que
 * corregirlo», y hasta ahora la única salida era volver a grabar el proceso
 * entero. «Editar» trae los pasos y sus capturas a la sesión, donde son pasos
 * normales (se reordenan, se redactan con IA, se les añaden secciones); al
 * guardar, el paquete se reescribe donde estaba y el commit nuevo se apila
 * encima, en la rama de la que salió. El commit original no se toca: el
 * historial sigue contando lo que pasó.
 */
export function CommitDocsPreview({
  repoRoot,
  commit,
  subject,
  branch,
  onClose,
  onEdited
}: {
  repoRoot: string
  commit: string
  subject: string
  /** rama desde la que se está mirando el commit: es donde irá la corrección */
  branch: string
  onClose: () => void
  /** la documentación se cargó en la sesión: quien abrió esto debe apartarse */
  onEdited: () => void
}): React.JSX.Element {
  const loadCommitDoc = useSession((s) => s.loadCommitDoc)
  const [docs, setDocs] = useState<CommitDocs[] | null>(null)
  /** funcionalidad que se va a editar, a la espera de confirmar */
  const [confirming, setConfirming] = useState<CommitDocs | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

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

  const edit = async (doc: CommitDocs): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const loaded = await ipc.invoke('git:commit-doc-edit', {
        repoRoot,
        commit,
        path: doc.path
      })
      if (!loaded) {
        setProblem('No se pudo leer esta documentación del commit.')
        return
      }
      loadCommitDoc(loaded, branch)
      // El borrador se guarda solo con lo cargado, así que cerrar la app aquí ya
      // no pierde nada.
      onClose()
      onEdited()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Cargar pisa la sesión actual. Si hay una grabación en curso hay que decirlo
   * ANTES: su borrador se sobrescribe en cuanto entra lo del commit.
   */
  const askEdit = (doc: CommitDocs): void => {
    const current = useSession.getState().steps.length
    if (current > 0) setConfirming(doc)
    else void edit(doc)
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2>{subject}</h2>
            <span className="muted">
              commit {commit} · rama {branch}
            </span>
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
              <div className="preview-feature-head">
                <h3>{d.session.title || d.session.feature}</h3>
                <button
                  className="btn"
                  disabled={busy}
                  data-edit={d.session.feature}
                  title={`Traer esta documentación a la sesión para corregirla y volver a registrarla en «${branch}»`}
                  onClick={() => askEdit(d)}
                >
                  {busy ? 'Cargando…' : '✎ Editar esta documentación'}
                </button>
              </div>
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

        {confirming && (
          <ConfirmDialog
            title="Sustituir la grabación en curso"
            body={[
              `Ahora mismo tienes ${useSession.getState().steps.length} paso(s) en el panel.`,
              '',
              `Al editar «${confirming.session.title || confirming.session.feature}» se sustituyen por los de este commit, y el borrador guardado también.`,
              'Si lo que tienes ahora te importa, guárdalo antes (■) y vuelve aquí.'
            ].join('\n')}
            confirmLabel="Sustituir y editar"
            cancelLabel="Cancelar"
            tone="danger"
            onConfirm={() => {
              const doc = confirming
              setConfirming(null)
              void edit(doc)
            }}
            onCancel={() => setConfirming(null)}
          />
        )}

        {problem && (
          <ConfirmDialog
            title="No se pudo abrir para editar"
            body={problem}
            confirmLabel="Entendido"
            onConfirm={() => setProblem(null)}
          />
        )}
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
    if (!step.screenshot) return
    const imagePath = sessionPath.replace(/session\.json$/, '') + step.screenshot
    void ipc.invoke('git:doc-image', { repoRoot, commit, imagePath }).then(setImg)
  }, [repoRoot, commit, sessionPath, step.screenshot])

  // Una sección no es un paso: encabeza los siguientes, y así se lee también aquí.
  if (step.kind === 'section') {
    return (
      <li className="preview-step preview-section">
        <b>{step.title || 'Sección sin título'}</b>
        {step.description && <p>{step.description}</p>}
      </li>
    )
  }

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
