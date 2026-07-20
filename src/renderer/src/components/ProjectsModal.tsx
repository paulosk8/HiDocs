import { useCallback, useEffect, useState } from 'react'
import type { GitBranchInfo, GitCommitInfo, ProjectEntry } from '../../../shared/types'
import { ipc } from '../ipc'
import { useSession } from '../store'

/**
 * Explorador de los repositorios de documentación ya usados.
 *
 * Es de SOLO LECTURA sobre el repositorio: navega repositorios → ramas →
 * historial, y lo único que escribe es la elección de rama base para la próxima
 * grabación. No hace checkout, no crea ramas y no toca el historial; el
 * repositorio Docusaurus lo mantiene otra persona y esta ventana no debe poder
 * estropearle el trabajo.
 *
 * «Quitar de la lista» solo olvida la entrada del registro: el repositorio sigue
 * en el disco intacto.
 */
export function ProjectsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null)
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  // Los resultados se guardan junto a la clave que los pidió. Así «cargando» se
  // deduce comparando claves, en vez de vaciar el estado dentro del efecto, y una
  // respuesta lenta de un repositorio ya abandonado se ignora sola.
  const [branchData, setBranchData] = useState<{ key: string; items: GitBranchInfo[] } | null>(null)
  const [commitData, setCommitData] = useState<{ key: string; items: GitCommitInfo[] } | null>(null)

  // Separador NUL: una ruta puede contener espacios, y con un espacio como
  // separador dos pares (repositorio, rama) distintos darían la misma clave.
  const commitKey = `${repoRoot ?? ''}\0${branch ?? ''}`
  const branches = branchData?.key === repoRoot ? branchData.items : null
  const commits = commitData?.key === commitKey ? commitData.items : null

  const repo = useSession((s) => s.gitRepo)
  const baseBranch = useSession((s) => s.gitBaseBranch)
  const setGitBaseBranch = useSession((s) => s.setGitBaseBranch)
  const setOutputDir = useSession((s) => s.setOutputDir)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // El repositorio de la sesión actual puede no estar aún en el registro (solo
  // se guarda al commitear), así que se preselecciona por separado.
  useEffect(() => {
    void ipc.invoke('projects:list').then((list) => {
      setProjects(list)
      setRepoRoot((current) => current ?? repo?.root ?? list.find((p) => !p.missing)?.root ?? null)
    })
  }, [repo?.root])

  useEffect(() => {
    if (!repoRoot) return
    void ipc
      .invoke('git:branches', repoRoot)
      .then((items) => setBranchData({ key: repoRoot, items }))
  }, [repoRoot])

  useEffect(() => {
    if (!repoRoot || !branch) return
    void ipc
      .invoke('git:commits', { repoRoot, branch })
      .then((items) => setCommitData({ key: commitKey, items }))
  }, [repoRoot, branch, commitKey])

  const forget = useCallback(async (root: string) => {
    const list = await ipc.invoke('projects:forget', root)
    setProjects(list)
    setRepoRoot((current) => {
      if (current !== root) return current
      setBranch(null)
      return list[0]?.root ?? null
    })
  }, [])

  // Elegir la base solo tiene efecto sobre el repositorio de la sesión actual:
  // en otro repositorio esa rama no existe y el guardado fallaría.
  const isSessionRepo = !!repo && repo.root === repoRoot
  const selected = projects?.find((p) => p.root === repoRoot)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="projects-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Repositorios de documentación</h2>
          <button onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>

        <div className="projects-columns">
          <section className="projects-col">
            <h3>Proyectos</h3>
            {projects === null && <p className="muted">Cargando…</p>}
            {projects?.length === 0 && (
              <p className="muted">
                Todavía no hay ninguno. Elige una carpeta de salida dentro del repositorio
                Docusaurus y guarda una grabación: se añadirá aquí sola.
              </p>
            )}
            <ul>
              {projects?.map((p) => (
                <li key={p.root}>
                  <button
                    className={p.root === repoRoot ? 'row selected' : 'row'}
                    onClick={() => {
                      // La rama pertenece al repositorio anterior: dejarla
                      // seleccionada mostraría un historial que no es de aquí.
                      setRepoRoot(p.root)
                      setBranch(null)
                    }}
                    title={p.root}
                  >
                    <b>{p.label}</b>
                    {p.missing && <em className="warn">carpeta no encontrada</em>}
                    {p.root === repo?.root && <em>sesión actual</em>}
                  </button>
                  <button className="link" onClick={() => void forget(p.root)}>
                    Quitar de la lista
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="projects-col">
            <h3>Ramas</h3>
            {!repoRoot && <p className="muted">Elige un proyecto.</p>}
            {repoRoot && branches === null && <p className="muted">Leyendo ramas…</p>}
            {branches?.length === 0 && (
              <p className="muted">Este repositorio no tiene ramas legibles.</p>
            )}
            <ul>
              {branches?.map((b) => (
                <li key={b.name}>
                  <button
                    className={b.name === branch ? 'row selected' : 'row'}
                    onClick={() => setBranch(b.name)}
                  >
                    <b>
                      {b.name} {b.current && <em>activa</em>}
                    </b>
                    <span className="muted">{b.lastCommitSubject}</span>
                    {b.aheadOfDefault > 0 && (
                      <span className="muted">
                        {b.aheadOfDefault} commit(s) por delante de la rama por defecto
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="projects-col">
            <h3>Historial{branch ? ` de ${branch}` : ''}</h3>
            {!branch && <p className="muted">Elige una rama.</p>}
            {branch && commits === null && <p className="muted">Leyendo historial…</p>}
            {commits?.length === 0 && <p className="muted">Sin commits.</p>}
            <ol className="commits">
              {commits?.map((c) => (
                <li key={c.hash}>
                  <code>{c.hash}</code> {c.subject}
                  <span className="muted">
                    {c.author} · {c.date.slice(0, 16)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <footer>
          {selected && selected.root !== repo?.root && (
            <button
              onClick={() => {
                // Cambiar de proyecto es cambiar la carpeta de salida: la
                // inspección Git cuelga de ella, así que no hay dos fuentes de
                // verdad sobre a qué repositorio se documenta.
                setOutputDir(selected.lastOutputDir || selected.root)
                onClose()
              }}
              disabled={selected.missing}
            >
              Usar este proyecto para la sesión
            </button>
          )}

          {isSessionRepo && branch && (
            <button
              onClick={() => {
                setGitBaseBranch(branch === repo?.defaultBranch ? null : branch)
                onClose()
              }}
            >
              Partir de <code>{branch}</code> en la próxima grabación
            </button>
          )}
          {baseBranch && (
            <p className="git-note">
              La próxima rama nacerá de <code>{baseBranch}</code>.{' '}
              <button className="link" onClick={() => setGitBaseBranch(null)}>
                Volver a la rama por defecto
              </button>
            </p>
          )}
        </footer>
      </div>
    </div>
  )
}
