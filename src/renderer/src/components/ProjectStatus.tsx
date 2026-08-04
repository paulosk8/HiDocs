import { useEffect, useState } from 'react'
import { suggestBranchName } from '../../../shared/naming'
import { ipc } from '../ipc'
import { useSession } from '../store'
import { invalidateBranches, useBranches } from '../useBranches'
import { BranchPicker } from './BranchPicker'

/**
 * Franja de estado del repositorio de la sesión actual.
 *
 * Vive entre la barra superior y el workspace —fuera del rectángulo que cubre la
 * vista nativa—, así que sigue visible aunque el panel de pasos esté colapsado.
 * Resume de un vistazo todo lo relativo a Git: dónde se documenta, en qué rama
 * se registrará lo que se grabe, si hay cambios que bloquearían el commit y
 * cuántos repositorios se han usado ya.
 *
 * La rama de trabajo es aquí un control, no un dato: es el sitio donde se
 * empieza a trabajar, y por eso el selector cuelga de ella (§10 de SPEC).
 */
export function ProjectStatus(): React.JSX.Element {
  const repo = useSession((s) => s.gitRepo)
  const meta = useSession((s) => s.meta)
  const outputDir = useSession((s) => s.outputDir)
  const setOutputDir = useSession((s) => s.setOutputDir)
  const baseBranch = useSession((s) => s.gitBaseBranch)
  const branchOverride = useSession((s) => s.gitBranchOverride)
  const pickerOpen = useSession((s) => s.branchPickerOpen)
  const setPickerOpen = useSession((s) => s.setBranchPickerOpen)
  const projectsOpen = useSession((s) => s.projectsOpen)
  const setProjectsOpen = useSession((s) => s.setProjectsOpen)
  const pendingDocsOpen = useSession((s) => s.pendingDocsOpen)
  const setPendingDocsOpen = useSession((s) => s.setPendingDocsOpen)
  const [pendingDocs, setPendingDocs] = useState(0)
  const [projectCount, setProjectCount] = useState<number | null>(null)
  const [docsDir, setDocsDir] = useState<string | null>(null)
  const branches = useBranches(repo?.root)

  // Se recuenta al cambiar de repositorio y al cerrar el explorador (donde se
  // pueden olvidar proyectos). Mientras está abierto no: el número no cambia a la
  // vista y evita una consulta redundante.
  useEffect(() => {
    if (projectsOpen) return
    void ipc.invoke('projects:list').then((list) => setProjectCount(list.length))
  }, [repo?.root, projectsOpen])

  // Paquetes escritos y sin registrar en Git. Se recuenta con cada inspección del
  // repositorio (cambiar de carpeta, guardar) y al cerrar la lista, que es donde
  // se registran: mientras está abierta manda ella, que ya relee por su cuenta.
  useEffect(() => {
    // Sin repositorio no hay nada que contar, y el aviso tampoco se pinta: la
    // franja entera es otra en ese caso.
    if (pendingDocsOpen || !repo?.root) return
    void ipc.invoke('git:pending-docs', repo.root).then((docs) => setPendingDocs(docs.length))
  }, [repo, pendingDocsOpen])

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
      <div className="status-strip">
        {docsWarning}
        <div className="project-status muted">
          <span>La carpeta de salida no está en un repositorio Git.</span>
          {projectsChip}
        </div>
      </div>
    )
  }

  // Solo bloquean el commit los cambios que NO son de DocRecorder; aquí no se
  // distinguen archivo a archivo, pero cualquier cambio pendiente o indexado
  // merece un aviso antes de guardar.
  const pending = repo.stagedPaths.length + repo.dirtyPaths.length
  const clean = pending === 0
  // Rama donde irá el commit: la elegida, o la sugerida por el módulo mientras
  // no se elija ninguna.
  const target = branchOverride ?? suggestBranchName(meta.module)
  // Mientras las ramas no han llegado no se puede afirmar que la rama no exista,
  // y decir «nacerá de main» sobre una rama que sí existe confunde más que callar.
  const isNew = branches !== null && !branches.some((b) => b.name === target)
  const nextBase = baseBranch ?? repo.defaultBranch ?? repo.branch

  return (
    // El selector cuelga de la franja, así que la franja es su contexto de
    // posicionamiento: el desplegable debe poder salirse de ella sin recortarse.
    <div className="status-strip">
      {docsWarning}
      <div className="project-status">
        <span className={`status-dot ${clean ? 'ok' : 'warn'}`} aria-hidden />
        <span className="status-repo" title={repo.root}>
          {repo.root.split('/').pop()}
        </span>
        <span className="status-sep">·</span>
        <span>
          rama de trabajo{' '}
          <button
            className="branch-chip"
            onClick={() => {
              // Al abrirlo se releen las ramas: puede haber nacido alguna por
              // fuera (o en el último guardado) desde la última vez.
              if (!pickerOpen) invalidateBranches()
              setPickerOpen(!pickerOpen)
            }}
            title="Elegir en qué rama continuar, o estrenar una"
            aria-expanded={pickerOpen}
          >
            <code>{target}</code>
            <span aria-hidden>▾</span>
          </button>
          {branchOverride && <em className="status-tag">elegida</em>}
        </span>
        {isNew && (
          <>
            <span className="status-sep">·</span>
            <span>
              nacerá de <code>{nextBase}</code>
            </span>
          </>
        )}
        {!isNew && repo.branch !== target && (
          <>
            <span className="status-sep">·</span>
            <span className="muted">
              ahora en <code>{repo.branch}</code>; se cambiará al guardar
            </span>
          </>
        )}
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
        {pendingDocs > 0 && (
          <>
            <span className="status-sep">·</span>
            <button
              className="status-link warn"
              onClick={() => setPendingDocsOpen(true)}
              title="Documentación escrita en el repositorio que Git no tiene registrada todavía"
            >
              ⚠ {pendingDocs} sin registrar
            </button>
          </>
        )}
        <span className="status-spacer" />
        {projectsChip}
      </div>
      {pickerOpen && <BranchPicker branches={branches} onClose={() => setPickerOpen(false)} />}
    </div>
  )
}
