import { useEffect, useRef, useState } from 'react'
import { suggestBranchName, validateBranchName } from '../../../shared/naming'
import type { BranchDocInfo, GitBranchInfo } from '../../../shared/types'
import { ipc } from '../ipc'
import { useSession } from '../store'

/**
 * Selector de la rama de trabajo, desplegado desde la franja de estado.
 *
 * Resuelve el caso de «seguir en la rama de ayer»: se elige una rama existente y
 * los metadatos con los que se documentó (módulo, rol, URL base) se recuperan de
 * su último `session.json` commiteado, en vez de volver a escribirlos. También
 * ofrece la otra mitad del trabajo diario: estrenar rama, con su base.
 *
 * Elegir aquí NO hace checkout. La rama se cambia (o se crea) al guardar, con
 * las salvaguardas de `commitDocs`; hasta entonces esto es una declaración de
 * intenciones, que es lo que permite ofrecerlo sin riesgo sobre un repositorio
 * ajeno.
 */
export function BranchPicker({
  branches,
  onClose
}: {
  /** ramas locales ya leídas por la franja de estado; `null` mientras cargan */
  branches: GitBranchInfo[] | null
  onClose: () => void
}): React.JSX.Element {
  const repo = useSession((s) => s.gitRepo)
  const meta = useSession((s) => s.meta)
  const chosen = useSession((s) => s.gitBranchOverride)
  const baseBranch = useSession((s) => s.gitBaseBranch)
  const adoptBranch = useSession((s) => s.adoptBranch)
  const loadBranchDoc = useSession((s) => s.loadBranchDoc)
  const setGitBranch = useSession((s) => s.setGitBranch)
  const setGitBaseBranch = useSession((s) => s.setGitBaseBranch)

  const [filter, setFilter] = useState('')
  const [newName, setNewName] = useState<string | null>(null)
  // Igual que en el explorador: el resultado viaja con la clave que lo pidió, así
  // una respuesta lenta de una rama ya abandonada se ignora sola.
  const [docData, setDocData] = useState<{ key: string; items: BranchDocInfo[] } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  const root = repo?.root
  const current = chosen ?? suggestBranchName(meta.module)
  const exists = branches?.some((b) => b.name === current) ?? false
  const docKey = `${root ?? ''}\0${current}`
  const docs = docData?.key === docKey ? docData.items : null

  // Cerrar al pulsar fuera o con Escape: es un desplegable, no un diálogo modal.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Documentación de la rama elegida. Solo si la rama existe: en una rama que
  // aún no se ha creado no hay nada que leer.
  useEffect(() => {
    if (!root || !exists || docData?.key === docKey) return
    void ipc
      .invoke('git:branch-docs', { repoRoot: root, branch: current })
      .then((items) => setDocData({ key: docKey, items }))
  }, [root, current, exists, docKey, docData?.key])

  const pick = async (name: string): Promise<void> => {
    if (!root) return
    const items = await ipc.invoke('git:branch-docs', { repoRoot: root, branch: name })
    setDocData({ key: `${root}\0${name}`, items })
    // El más reciente es el que dice con qué módulo y rol se venía trabajando.
    adoptBranch(name, items[0] ?? null)
  }

  const proposed = newName ?? suggestBranchName(meta.module)
  const nameError = validateBranchName(proposed)
  const collides = branches?.some((b) => b.name === proposed) ?? false
  const base = baseBranch ?? repo?.defaultBranch ?? repo?.branch ?? ''

  const visible = branches?.filter((b) => b.name.includes(filter.trim())) ?? []

  return (
    <div className="branch-picker" ref={box}>
      <header>
        <b>Rama de trabajo</b>
        <span className="muted">
          se registrará aquí al guardar; el cambio de rama ocurre entonces, no ahora
        </span>
      </header>

      <input
        className="branch-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Buscar rama…"
        autoFocus
        spellCheck={false}
      />

      <ul className="branch-list">
        {branches === null && <li className="muted">Leyendo ramas…</li>}
        {branches !== null && visible.length === 0 && (
          <li className="muted">Ninguna rama coincide.</li>
        )}
        {visible.map((b) => (
          <li key={b.name}>
            <button
              className={b.name === current ? 'row selected' : 'row'}
              data-branch={b.name}
              onClick={() => void pick(b.name)}
            >
              <b>
                {b.name}
                {b.name === current && <em className="status-tag">elegida</em>}
                {b.current && <em className="status-tag">HEAD</em>}
              </b>
              <span className="muted">{b.lastCommitSubject}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* Lo que esa rama ya documenta: sirve para no repetir una funcionalidad y
          para retomar una concreta con sus metadatos exactos. */}
      {exists && (
        <div className="branch-docs">
          {docs === null && <p className="muted">Leyendo lo documentado en la rama…</p>}
          {docs?.length === 0 && (
            <p className="muted">
              Esta rama todavía no tiene documentación registrada por DocRecorder.
            </p>
          )}
          {docs && docs.length > 0 && (
            <>
              <p className="muted">
                Ya documentado aquí — pulsa una para retomarla con sus datos:
              </p>
              <ul>
                {docs.map((d) => (
                  <li key={d.path}>
                    <button
                      className="row"
                      data-feature={d.feature}
                      onClick={() => {
                        loadBranchDoc(d)
                        onClose()
                      }}
                      title={d.path}
                    >
                      <b>{d.title || d.feature}</b>
                      <span className="muted">
                        {d.module}/{d.feature}
                        {d.role && ` · rol ${d.role}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="branch-new">
        <b>Rama nueva</b>
        <div className="branch-new-row">
          <input
            value={proposed}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="docs/…"
            spellCheck={false}
          />
          <label>
            desde
            <select
              value={base}
              // `null` cuando es la rama por defecto: así «base elegida» sigue
              // significando que se pidió una distinta a propósito.
              onChange={(e) =>
                setGitBaseBranch(e.target.value === repo?.defaultBranch ? null : e.target.value)
              }
              disabled={!branches?.length}
            >
              {branches?.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!!nameError}
            onClick={() => {
              setGitBranch(proposed.trim())
              onClose()
            }}
          >
            Usar
          </button>
        </div>
        {nameError && <p className="error">{nameError}</p>}
        {!nameError && collides && (
          <p className="muted">
            <code>{proposed}</code> ya existe: el commit se añadirá encima, sin tocar la base.
          </p>
        )}
        {!nameError && !collides && (
          <p className="muted">
            Se creará al guardar, desde <code>{base}</code>.
          </p>
        )}
      </div>
    </div>
  )
}
