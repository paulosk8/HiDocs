import { suggestCommitMessage } from '../../../shared/naming'
import { targetBranch, useSession } from '../store'
import { useBranches } from '../useBranches'

/**
 * Integración con el repositorio de documentación.
 *
 * Solo aparece cuando la carpeta de salida está dentro de un repositorio Git:
 * no hay nada que configurar: elegir la carpeta ya dice a qué repositorio va.
 */
export function GitSection(): React.JSX.Element | null {
  const outputDir = useSession((s) => s.outputDir)
  const meta = useSession((s) => s.meta)
  const repo = useSession((s) => s.gitRepo)
  const enabled = useSession((s) => s.gitEnabled)
  const push = useSession((s) => s.gitPush)
  const baseBranch = useSession((s) => s.gitBaseBranch)
  const setBranchPickerOpen = useSession((s) => s.setBranchPickerOpen)
  const branchOverride = useSession((s) => s.gitBranchOverride)
  const messageOverride = useSession((s) => s.gitMessageOverride)
  const setGit = useSession((s) => s.setGit)
  const setGitBranch = useSession((s) => s.setGitBranch)
  const setGitMessage = useSession((s) => s.setGitMessage)
  const mode = useSession((s) => s.gitBranchMode)
  const setGitBranchMode = useSession((s) => s.setGitBranchMode)

  // La inspección del repositorio vive en App (useRepoInspection), no aquí: esta
  // sección se desmonta al colapsar el panel y dejaría sin datos a la franja de
  // estado. Aquí solo se lee `gitRepo` del store.

  // Ramas existentes, para ofrecerlas como sugerencia en el campo y para saber si
  // la elegida ya existe. Vienen de la caché compartida con la franja de estado:
  // las dos vistas hablan de lo mismo y no se consulta `git` dos veces.
  const branches = useBranches(repo?.root)

  // Antes esto devolvía null y la sección desaparecía sin más: con una carpeta
  // fuera de un repositorio parecía que la integración Git no existía. Decirlo
  // cuesta una línea y evita esa confusión.
  if (!repo) {
    return outputDir ? (
      <section className="git-section">
        <p className="git-note">
          La carpeta de salida no está dentro de un repositorio Git, así que la documentación solo
          se guardará en disco. Elige una carpeta dentro del repositorio Docusaurus para registrarla
          en una rama.
        </p>
      </section>
    ) : null
  }

  const branch = targetBranch({ gitBranchOverride: branchOverride, gitBranchMode: mode, meta })
  // Por guía y sin funcionalidad escrita, el nombre está a medias (`docs/x-…`).
  const pendingName = branchOverride === null && branch.endsWith('…')
  const message = messageOverride ?? suggestCommitMessage(meta.module, meta.feature, meta.title)
  const switching = repo.branch !== branch
  // Mientras la lista no ha llegado no se afirma nada: decir que una rama que sí
  // existe «nacerá de main» es peor que esperar un instante a saberlo.
  const isNew = !pendingName && branches !== null && !branches.some((b) => b.name === branch)

  return (
    <section className="git-section">
      <label className="git-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setGit({ gitEnabled: e.target.checked })}
        />
        <span>
          Registrar en Git al guardar
          <em title={repo.root}>
            {repo.root.split('/').pop()} · rama actual <code>{repo.branch}</code>
          </em>
        </span>
      </label>

      {enabled && (
        <div className="git-fields">
          {/* Cómo se llama la rama mientras no se elija una (§21). Elegir una
              concreta —aquí, en la franja o en el explorador— manda sobre esto
              hasta que se vuelva al nombre automático. */}
          <div className="git-mode" role="radiogroup" aria-label="Nombre automático de la rama">
            <span>Una rama por</span>
            {(['guide', 'module'] as const).map((value) => (
              <button
                key={value}
                role="radio"
                aria-checked={mode === value && branchOverride === null}
                className={mode === value && branchOverride === null ? 'on' : ''}
                onClick={() => {
                  setGitBranchMode(value)
                  setGitBranch(null)
                }}
                title={
                  value === 'guide'
                    ? 'Cada guía estrena su rama (docs/<módulo>-<funcionalidad>): una PR por guía'
                    : 'Las guías de un módulo se acumulan en docs/<módulo>: una PR por módulo'
                }
              >
                {value === 'guide' ? 'guía' : 'módulo'}
              </button>
            ))}
            {branchOverride !== null && (
              <em>
                elegida a mano ·{' '}
                <button className="link" onClick={() => setGitBranch(null)}>
                  volver al nombre automático
                </button>
              </em>
            )}
          </div>
          <label className="field">
            <span>Rama</span>
            {/* Escribe en el MISMO estado que el selector de la franja superior
                (`gitBranchOverride`): dos editores, una sola rama de trabajo.
                `list` ofrece las existentes sin dejar de ser un campo de texto. */}
            <input
              value={branch}
              onChange={(e) => setGitBranch(e.target.value)}
              spellCheck={false}
              list="git-branches"
              placeholder="docs/…"
            />
            <datalist id="git-branches">
              {branches?.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.current ? 'rama actual' : b.lastCommitSubject}
                </option>
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>Mensaje del commit</span>
            <input value={message} onChange={(e) => setGitMessage(e.target.value)} />
          </label>

          <label className="git-toggle small">
            <input
              type="checkbox"
              checked={push}
              disabled={!repo.remoteUrl}
              onChange={(e) => setGit({ gitPush: e.target.checked })}
            />
            <span>
              {repo.remoteUrl
                ? 'Subir la rama a origin después del commit'
                : 'Sin remoto «origin»: solo commit local'}
            </span>
          </label>

          {/* La base solo interviene al CREAR la rama: si ya existe, el commit se
              añade encima. Ahora se sabe cuál de los dos casos es, porque la
              lista de ramas está cacheada y no cuesta un `git` por tecla. */}
          <p className="git-note">
            {pendingName ? (
              <>
                El nombre se completa con la funcionalidad y nacerá de{' '}
                <code>{baseBranch ?? repo.defaultBranch ?? repo.branch}</code>.{' '}
              </>
            ) : isNew ? (
              <>
                <code>{branch}</code> aún no existe: nacerá de{' '}
                <code>{baseBranch ?? repo.defaultBranch ?? repo.branch}</code>
                {!baseBranch && !repo.defaultBranch && ' (no se encontró la rama por defecto)'}
                .{' '}
              </>
            ) : (
              <>
                <code>{branch}</code> ya existe: el commit se añadirá encima.{' '}
              </>
            )}
            <button className="link" onClick={() => setBranchPickerOpen(true)}>
              Elegir rama…
            </button>
          </p>
          {switching && !pendingName && (
            <p className="git-note">
              Se cambiará de <code>{repo.branch}</code> a <code>{branch}</code>
              {repo.dirtyPaths.length > 0 &&
                ` — hay ${repo.dirtyPaths.length} archivo(s) sin guardar que lo impedirán`}
              .
            </p>
          )}
          {repo.stagedPaths.length > 0 && (
            <p className="git-note warn">
              El repositorio tiene {repo.stagedPaths.length} archivo(s) ya indexados. Haz commit o
              guárdalos en un stash: si no, acabarían dentro de este commit.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
