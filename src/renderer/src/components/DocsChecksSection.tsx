import { ipc } from '../ipc'
import { featureSegments } from '../../../shared/naming'
import { checksToRun, useSession } from '../store'

/**
 * Comprobación del sitio y vista previa (§17).
 *
 * Vive debajo de la sección Git porque habla de lo mismo: qué pasa al pulsar ■.
 * No se inventa ningún comando: enumera los que el `package.json` del proyecto
 * de destino tiene, y si no tiene ninguno lo dice en vez de callar (callar
 * parecería que la comprobación está y no hace nada).
 */
export function DocsChecksSection(): React.JSX.Element | null {
  const outputDir = useSession((s) => s.outputDir)
  const project = useSession((s) => s.docsChecks)
  const verify = useSession((s) => s.gitVerify)
  const setGit = useSession((s) => s.setGit)
  const checksSkip = useSession((s) => s.checksSkip)
  const toggleCheck = useSession((s) => s.toggleCheck)
  const setRequirementsOpen = useSession((s) => s.setRequirementsOpen)
  const meta = useSession((s) => s.meta)
  const previewUrl = useSession((s) => s.previewUrl)
  const busy = useSession((s) => s.checksRun !== null)
  const checksStart = useSession((s) => s.checksStart)
  const checksFinish = useSession((s) => s.checksFinish)
  const setPreviewUrl = useSession((s) => s.setPreviewUrl)

  if (!outputDir) return null

  if (!project) {
    return (
      <section className="git-section">
        <p className="git-note">
          La carpeta de salida no está dentro de un proyecto Docusaurus con{' '}
          <code>package.json</code>, así que no hay nada que comprobar antes de registrar.
        </p>
      </section>
    )
  }

  const willRun = checksToRun(project, checksSkip)

  const preview = async (): Promise<void> => {
    checksStart('preview')
    const result = await ipc.invoke('preview:start', {
      outputDir,
      // Las carpetas de la guía en curso: es la página que se quiere mirar.
      segments: featureSegments(meta.module, meta.subcategory ?? '', meta.feature)
    })
    if (result.url) {
      setPreviewUrl(result.url)
      checksFinish()
    } else {
      setPreviewUrl(null)
      checksFinish({ result: result.checks, error: result.error })
    }
  }

  const stop = async (): Promise<void> => {
    await ipc.invoke('preview:stop')
    setPreviewUrl(null)
  }

  return (
    <section className="git-section">
      {/* El resumen dice CUÁNTOS comandos, no cuáles: los nombres están en la
          lista de abajo y con cinco de ellos la línea se cortaba a media
          palabra. */}
      <label className="git-toggle">
        <input
          type="checkbox"
          checked={verify}
          disabled={!project.checks.length}
          onChange={(e) => setGit({ gitVerify: e.target.checked })}
        />
        <span>
          Comprobar el sitio antes de registrar en Git
          {project.checks.length ? (
            <em title={project.projectRoot}>
              {willRun.length
                ? `${willRun.length} de ${project.checks.length} comando(s) de este proyecto`
                : 'no has dejado marcado ninguno'}
            </em>
          ) : (
            <em>este proyecto no tiene ninguno de los comandos conocidos</em>
          )}
        </span>
      </label>

      {/* Una casilla por comando (§20). El interruptor de arriba es el «no
          comprobar nada»; aquí se elige qué merece la pena en ESTE proyecto:
          compilar el sitio entero cuesta minutos y no siempre hace falta
          pagarlos en cada guardado, mientras que el estilo y los tipos tardan
          segundos. La elección se recuerda por proyecto. */}
      {verify && project.checks.length > 0 && (
        <ul className="req-checks git-checks">
          {project.checks.map((check) => (
            <li key={check.script}>
              <label>
                <input
                  type="checkbox"
                  checked={!checksSkip.includes(check.script)}
                  onChange={() => toggleCheck(check.script)}
                />
                <span>
                  <code>npm run {check.script}</code> · {check.label}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {verify && willRun.length > 0 && (
        <p className="git-note">
          Se ejecutan en ese orden y se para en el primero que falle. Si algo falla,{' '}
          <strong>no se comitea</strong>: el paquete queda escrito y se puede corregir y volver a
          guardar.
        </p>
      )}

      <div className="git-preview">
        <button
          className="btn"
          title="Qué proyecto, qué rama, qué se ejecutará antes de registrar y cómo pide el repositorio que se escriba"
          onClick={() => setRequirementsOpen(true)}
        >
          Requisitos del proyecto
        </button>
      </div>

      <div className="git-preview">
        {previewUrl ? (
          <>
            <button className="btn" onClick={() => void stop()}>
              Detener la vista previa
            </button>
            <button
              className="link"
              onClick={() => void ipc.invoke('shell:open-external', previewUrl)}
            >
              {previewUrl}
            </button>
          </>
        ) : (
          <button
            className="btn"
            disabled={!project.canServe || busy}
            onClick={() => void preview()}
          >
            Vista previa del sitio
          </button>
        )}
      </div>
      <p className="git-note">
        {project.canServe
          ? 'Compila y sirve el sitio (npm run build && npm run serve) y lo abre en tu navegador. Es la única forma de ver el buscador funcionando: en modo desarrollo no indexa nada.'
          : 'Este proyecto no tiene los scripts «build» y «serve», así que la vista previa hay que levantarla a mano.'}
      </p>
    </section>
  )
}
