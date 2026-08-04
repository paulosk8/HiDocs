import { useEffect, useState } from 'react'
import { suggestBranchName, suggestCommitMessage, titleCase } from '../../../shared/naming'
import type { PendingDocInfo } from '../../../shared/types'
import { ipc } from '../ipc'
import { useSession } from '../store'
import { invalidateBranches } from '../useBranches'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * Documentación escrita en el repositorio que Git no tiene registrada.
 *
 * Existe porque escribir el paquete y hacer el commit son dos pasos separados
 * (§7): si el commit falla —o se guardó sin activar Git, o se cerró la app antes
 * de guardar el commit— el trabajo queda entero en el disco pero fuera del
 * historial, y hasta ahora la aplicación no lo leía: el árbol de la rama solo
 * muestra lo commiteado y la franja de estado no contaba los archivos sin
 * seguimiento. Aquí se ve, se registra en su rama y se puede retomar.
 *
 * Registrar usa el mismo camino que el guardado normal (`commitDocs`), con sus
 * salvaguardas: solo se indexan los archivos del paquete y nunca se sube nada a
 * origin sin pedirlo.
 *
 * Y lo contrario también: no todo lo que queda fuera del historial merece entrar
 * en él (una grabación de prueba, un proceso documentado dos veces, un intento a
 * medias). **Descartar** deshace ese trabajo sin salir de la aplicación: lo nuevo
 * va a la papelera del sistema —recuperable desde el escritorio— y lo que ya
 * estaba commiteado vuelve a su versión del último commit. Se pide confirmación
 * enumerando lo que va a ocurrir, porque es la única acción de esta ventana que
 * destruye algo.
 */
export function PendingDocsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const repo = useSession((s) => s.gitRepo)
  const loadBranchDoc = useSession((s) => s.loadBranchDoc)
  const [docs, setDocs] = useState<PendingDocInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState<string | null>(null)
  /** paquete cuyo descarte está pendiente de confirmar */
  const [discarding, setDiscarding] = useState<PendingDocInfo | null>(null)
  // Se relee tras registrar un paquete: el que acaba de comitearse desaparece de
  // la lista y los `_category_.json` que arrastró pueden cambiar los demás.
  const [reloadKey, setReloadKey] = useState(0)

  const root = repo?.root

  useEffect(() => {
    if (!root) return
    void ipc.invoke('git:pending-docs', root).then(setDocs)
  }, [root, reloadKey])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const register = async (doc: PendingDocInfo): Promise<void> => {
    if (!root) return
    setBusy(doc.dir)
    setProblem(null)
    try {
      const result = await ipc.invoke('git:commit-pending', {
        repoRoot: root,
        dir: doc.dir,
        // La rama de un módulo es la que dicta la convención del proyecto, no la
        // que esté ahora en HEAD: este paquete pertenece a su módulo aunque el
        // repositorio se haya quedado en otra rama.
        branch: suggestBranchName(doc.module),
        message: suggestCommitMessage(doc.module, doc.feature, doc.title),
        // Nunca se sube desde aquí: subir a un repositorio ajeno se pide a mano.
        push: false
      })
      setDone((prev) => ({ ...prev, [doc.dir]: result.message }))
      // La rama puede acabar de nacer y el repositorio de cambiar de HEAD.
      invalidateBranches()
      setReloadKey((k) => k + 1)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const discard = async (doc: PendingDocInfo): Promise<void> => {
    if (!root) return
    setBusy(doc.dir)
    setProblem(null)
    try {
      const result = await ipc.invoke('git:discard-pending', { repoRoot: root, dir: doc.dir })
      setDone((prev) => ({ ...prev, [doc.dir]: result.message }))
      setReloadKey((k) => k + 1)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="ai-modal pending-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Documentación sin registrar en Git</h2>
          <button onClick={onClose} aria-label="Cerrar la lista de documentación sin registrar">
            ×
          </button>
        </header>

        <div className="ai-body">
          <p className="ai-intro">
            Paquetes que están escritos en <code>{root?.split('/').pop()}</code> pero que Git no
            tiene al día. Registrarlos los comitea en la rama de su módulo, tal como están en el
            disco; no se sube nada a origin.
          </p>

          {docs === null && <p className="muted">Leyendo el repositorio…</p>}
          {docs?.length === 0 && (
            <p className="muted">
              Todo lo escrito está registrado en Git. Nada pendiente por aquí.
            </p>
          )}

          <ul className="pending-list">
            {docs?.map((doc) => (
              <li key={doc.dir}>
                <div className="pending-head">
                  <b>{doc.title || doc.feature}</b>
                  <em className="status-tag">{doc.untracked ? 'nunca commiteado' : 'cambiado'}</em>
                </div>
                <span className="muted">
                  {titleCase(doc.module)}
                  {doc.subcategory && ` / ${titleCase(doc.subcategory)}`} · {doc.steps} paso(s) ·{' '}
                  {doc.pendingFiles.length} archivo(s) pendiente(s)
                  {doc.createdAt && ` · ${new Date(doc.createdAt).toLocaleString('es')}`}
                </span>
                <code className="pending-path">{doc.dir}</code>
                {done[doc.dir] ? (
                  <p className="ai-saved">{done[doc.dir]}</p>
                ) : (
                  <div className="pending-actions">
                    <button
                      className="btn primary"
                      disabled={busy !== null}
                      onClick={() => void register(doc)}
                    >
                      {busy === doc.dir
                        ? 'Registrando…'
                        : `Registrar en ${suggestBranchName(doc.module)}`}
                    </button>
                    <button
                      className="btn"
                      title="Usa su módulo, rol y URL base para seguir documentando este proceso"
                      onClick={() => {
                        loadBranchDoc(doc)
                        onClose()
                      }}
                    >
                      Retomar sus datos
                    </button>
                    <button
                      className="btn"
                      onClick={() => void ipc.invoke('shell:open-path', `${root}/${doc.dir}`)}
                    >
                      Abrir carpeta
                    </button>
                    <button
                      className="btn danger"
                      disabled={busy !== null}
                      title="Deshacer este trabajo: lo nuevo va a la papelera del sistema y lo ya commiteado vuelve a su última versión"
                      onClick={() => setDiscarding(doc)}
                    >
                      Descartar
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {problem && <p className="ai-hint ai-problem">{problem}</p>}
        </div>

        <footer>
          <button className="btn" onClick={onClose}>
            Cerrar
          </button>
        </footer>

        {discarding && (
          <ConfirmDialog
            title="Descartar esta documentación"
            body={[
              `«${discarding.title || discarding.feature}» (${discarding.steps} paso(s)) dejará de estar en el disco:`,
              '',
              discarding.untracked
                ? `· La carpeta ${discarding.dir} entera irá a la papelera del sistema, capturas incluidas.`
                : `· Los ${discarding.pendingFiles.length} archivo(s) sin registrar irán a la papelera del sistema.`,
              discarding.untracked
                ? ''
                : '· Lo que ya estaba commiteado volverá a su versión del último commit.',
              '',
              'Nada de esto toca el historial de Git ni el resto del repositorio.',
              'Puedes recuperarlo desde la papelera si te arrepientes.'
            ]
              .filter((line, i, all) => line !== '' || all[i - 1] !== '')
              .join('\n')}
            confirmLabel="Descartar"
            cancelLabel="Cancelar"
            tone="danger"
            onConfirm={() => {
              const doc = discarding
              setDiscarding(null)
              void discard(doc)
            }}
            onCancel={() => setDiscarding(null)}
          />
        )}
      </div>
    </div>
  )
}
