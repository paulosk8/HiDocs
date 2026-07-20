import { suggestBranchName, suggestCommitMessage } from '../../../shared/naming'
import { useSession } from '../store'

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
  const setProjectsOpen = useSession((s) => s.setProjectsOpen)
  const branchOverride = useSession((s) => s.gitBranchOverride)
  const messageOverride = useSession((s) => s.gitMessageOverride)
  const setGit = useSession((s) => s.setGit)
  const setGitBranch = useSession((s) => s.setGitBranch)
  const setGitMessage = useSession((s) => s.setGitMessage)

  // La inspección del repositorio vive en App (useRepoInspection), no aquí: esta
  // sección se desmonta al colapsar el panel y dejaría sin datos a la franja de
  // estado. Aquí solo se lee `gitRepo` del store.

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

  const branch = branchOverride ?? suggestBranchName(meta.module, meta.feature)
  const message = messageOverride ?? suggestCommitMessage(meta.module, meta.feature, meta.title)
  const switching = repo.branch !== branch

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
          <label className="field">
            <span>Rama</span>
            <input
              value={branch}
              onChange={(e) => setGitBranch(e.target.value)}
              spellCheck={false}
            />
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

          {/* Condicional a propósito: el renderer no sabe si la rama ya existe
              —GitRepoInfo no lista ramas y consultarlas aquí lanzaría un proceso
              `git` por cada tecla—, y si existe, el commit se añade encima sin
              que la base intervenga. */}
          <p className="git-note">
            Si <code>{branch}</code> aún no existe, nacerá de{' '}
            <code>{baseBranch ?? repo.defaultBranch ?? repo.branch}</code>
            {!baseBranch && !repo.defaultBranch && ' (no se encontró la rama por defecto)'}.{' '}
            <button className="link" onClick={() => setProjectsOpen(true)}>
              Cambiar en Proyectos…
            </button>
          </p>
          {switching && (
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
