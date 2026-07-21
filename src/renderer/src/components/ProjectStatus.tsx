import { useEffect, useState } from 'react'
import { ipc } from '../ipc'
import { useSession } from '../store'

/**
 * Franja de estado del repositorio de la sesión actual.
 *
 * Vive entre la barra superior y el workspace —fuera del rectángulo que cubre la
 * vista nativa—, así que sigue visible aunque el panel de pasos esté colapsado.
 * Resume de un vistazo todo lo relativo a Git: dónde se documenta, de qué rama
 * nacerá la próxima grabación, si hay cambios que bloquearían el commit y cuántos
 * repositorios se han usado ya.
 */
export function ProjectStatus(): React.JSX.Element {
  const repo = useSession((s) => s.gitRepo)
  const outputDir = useSession((s) => s.outputDir)
  const setOutputDir = useSession((s) => s.setOutputDir)
  const baseBranch = useSession((s) => s.gitBaseBranch)
  const projectsOpen = useSession((s) => s.projectsOpen)
  const setProjectsOpen = useSession((s) => s.setProjectsOpen)
  const [projectCount, setProjectCount] = useState<number | null>(null)
  const [docsDir, setDocsDir] = useState<string | null>(null)

  // Se recuenta al cambiar de repositorio y al cerrar el explorador (donde se
  // pueden olvidar proyectos). Mientras está abierto no: el número no cambia a la
  // vista y evita una consulta redundante.
  useEffect(() => {
    if (projectsOpen) return
    void ipc.invoke('projects:list').then((list) => setProjectCount(list.length))
  }, [repo?.root, projectsOpen])

  // ¿La carpeta elegida es la raíz de un Docusaurus? Entonces la documentación
  // caería fuera de `docs/` y no se renderizaría.
  useEffect(() => {
    void ipc.invoke('docusaurus:suggest-docs', outputDir).then(setDocsDir)
  }, [outputDir])

  const projectsChip =
    projectCount !== null && projectCount > 0 ? (
      <button className="status-link" onClick={() => setProjectsOpen(true)}>
        {projectCount} proyecto{projectCount === 1 ? '' : 's'}
      </button>
    ) : null

  // Aviso prioritario: apuntar a la raíz de un Docusaurus es el error más común.
  const docsWarning = docsDir ? (
    <div className="docs-warning">
      <span>
        Esta carpeta es la raíz de un proyecto Docusaurus. La documentación solo se renderiza dentro
        de <code>docs/</code>.
      </span>
      <button className="docs-warning-btn" onClick={() => setOutputDir(docsDir)}>
        Usar la carpeta docs/
      </button>
    </div>
  ) : null

  if (!repo) {
    return (
      <>
        {docsWarning}
        <div className="project-status muted">
          <span>La carpeta de salida no está en un repositorio Git.</span>
          {projectsChip}
        </div>
      </>
    )
  }

  // Solo bloquean el commit los cambios que NO son de DocRecorder; aquí no se
  // distinguen archivo a archivo, pero cualquier cambio pendiente o indexado
  // merece un aviso antes de guardar.
  const pending = repo.stagedPaths.length + repo.dirtyPaths.length
  const nextBase = baseBranch ?? repo.defaultBranch ?? repo.branch
  const clean = pending === 0

  return (
    <>
      {docsWarning}
      <div className="project-status">
        <span className={`status-dot ${clean ? 'ok' : 'warn'}`} aria-hidden />
        <span className="status-repo" title={repo.root}>
          {repo.root.split('/').pop()}
        </span>
        <span className="status-sep">·</span>
        <span>
          rama <code>{repo.branch}</code>
        </span>
        <span className="status-sep">·</span>
        <span>
          próxima grabación desde <code>{nextBase}</code>
          {baseBranch && baseBranch !== repo.defaultBranch && (
            <em className="status-tag" title="Base elegida en el explorador">
              elegida
            </em>
          )}
        </span>
        <span className="status-sep">·</span>
        <span className={clean ? 'status-clean' : 'status-pending'}>
          {clean ? 'sin cambios pendientes' : `${pending} cambio(s) pendiente(s)`}
        </span>
        {!repo.remoteUrl && (
          <>
            <span className="status-sep">·</span>
            <span className="muted">sin remoto</span>
          </>
        )}
        <span className="status-spacer" />
        {projectsChip}
      </div>
    </>
  )
}
