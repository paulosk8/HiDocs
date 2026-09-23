import { checksToRun, targetBranch, useSession } from '../store'
import { GitSection } from './GitSection'
import { DocsChecksSection } from './DocsChecksSection'

/**
 * Pie del panel: registro en Git y comprobación del sitio, plegable.
 *
 * Desplegado ocupa media columna y deja las capturas en una franja por la que
 * cuesta desplazarse. Plegado queda una línea que sigue diciendo lo que importa
 * al pulsar ■ —si se registra, en qué rama y cuántos comandos se ejecutan—, así
 * que plegarlo no esconde ninguna decisión. Y el aviso de ■ repite la rama antes
 * de commitear.
 */
export function GitPanel(): React.JSX.Element | null {
  const collapsed = useSession((s) => s.gitPanelCollapsed)
  const toggle = useSession((s) => s.toggleGitPanel)
  const outputDir = useSession((s) => s.outputDir)
  const repo = useSession((s) => s.gitRepo)
  const enabled = useSession((s) => s.gitEnabled)
  const verify = useSession((s) => s.gitVerify)
  const project = useSession((s) => s.docsChecks)
  const checksSkip = useSession((s) => s.checksSkip)
  const branchOverride = useSession((s) => s.gitBranchOverride)
  const mode = useSession((s) => s.gitBranchMode)
  const meta = useSession((s) => s.meta)

  // Sin carpeta de salida ninguna de las dos secciones tiene nada que decir.
  if (!outputDir) return null

  const branch = targetBranch({ gitBranchOverride: branchOverride, gitBranchMode: mode, meta })
  const staged = repo?.stagedPaths.length ?? 0
  const willRun = project ? checksToRun(project, checksSkip).length : 0

  const summary = !repo ? (
    <span className="muted">solo en disco (sin repositorio Git)</span>
  ) : !enabled ? (
    <span className="muted">no se registra en Git</span>
  ) : (
    <>
      <span>
        Git → <code>{branch}</code>
      </span>
      {project && (
        <span className="muted">
          {verify && willRun > 0
            ? `comprueba ${willRun}/${project.checks.length}`
            : 'sin comprobar'}
        </span>
      )}
      {staged > 0 && <span className="warn">⚠ {staged} indexado(s)</span>}
    </>
  )

  return (
    <div className={`git-panel${collapsed ? ' collapsed' : ''}`}>
      <button
        className="git-panel-bar"
        onClick={toggle}
        aria-expanded={!collapsed}
        title={
          collapsed ? 'Mostrar las opciones de Git y comprobación' : 'Plegar para ver más pasos'
        }
      >
        <span className="git-panel-caret" aria-hidden>
          {collapsed ? '▸' : '▾'}
        </span>
        <strong>Registro</strong>
        {summary}
      </button>
      {!collapsed && (
        <div className="git-panel-body">
          <GitSection />
          <DocsChecksSection />
        </div>
      )}
    </div>
  )
}
