import { useEffect, useMemo, useState } from 'react'
import { ipc } from '../ipc'
import { renderMarkdown } from '../markdown'
import { checksToRun, useSession } from '../store'
import type { ProjectGuide } from '../../../shared/types'

/**
 * Ficha del proyecto de destino: con qué se va a trabajar y qué exige (§20).
 *
 * Nace de un fallo repetido y caro: el commit se bloqueaba una y otra vez porque
 * `lint:docs` aplica las reglas de redacción del repositorio —sin guion largo,
 * sin emojis, trato de tú— y esas reglas están escritas en su `CONTRIBUTING.md`,
 * fuera de esta aplicación. Quien documentaba se enteraba de ellas al final, con
 * la guía terminada, y corregir entonces cuesta mucho más que haberlo sabido.
 *
 * Por eso la ficha se enseña al empezar una guía, no al terminarla, y por eso
 * junta las dos mitades: los datos del proyecto (dónde escribe, en qué rama, qué
 * se ejecutará antes de registrar) y sus reglas de redacción, leídas del propio
 * repositorio. No se inventa ninguna: si el proyecto no tiene guía de estilo, lo
 * dice.
 */

/** Sin tildes y en minúsculas, para que buscar «redaccion» encuentre «redacción». */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Parte la guía en secciones por sus encabezados. Buscar dentro de un documento
 * de cuatrocientas líneas no es leerlo entero: es quedarse con el apartado que
 * habla de lo que preguntas, con su contexto.
 */
function sections(markdown: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced
    if (!fenced && /^#{1,6}\s/.test(line) && current.length) {
      out.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length) out.push(current.join('\n'))
  return out
}

export function RequirementsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const outputDir = useSession((s) => s.outputDir)
  const project = useSession((s) => s.docsChecks)
  const repo = useSession((s) => s.gitRepo)
  const branchOverride = useSession((s) => s.gitBranchOverride)
  const verify = useSession((s) => s.gitVerify)
  const setGit = useSession((s) => s.setGit)
  const checksSkip = useSession((s) => s.checksSkip)
  const toggleCheck = useSession((s) => s.toggleCheck)
  const onStart = useSession((s) => s.requirementsOnStart)
  const setOnStart = useSession((s) => s.setRequirementsOnStart)

  const [guide, setGuide] = useState<ProjectGuide | null | 'loading'>('loading')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // La ficha se monta y se desmonta con la ventana, así que la carpeta de salida
  // no cambia mientras está abierta: basta con pedir la guía una vez y quedarse
  // con lo que llegue (o descartarlo si para entonces ya se cerró).
  useEffect(() => {
    let cancelled = false
    void ipc.invoke('docs:guide', outputDir).then((found) => {
      if (!cancelled) setGuide(found)
    })
    return () => {
      cancelled = true
    }
  }, [outputDir])

  const blocks = useMemo(
    () => (guide && guide !== 'loading' ? sections(guide.content) : []),
    [guide]
  )
  const shown = useMemo(() => {
    const needle = fold(query.trim())
    if (!needle) return blocks
    return blocks.filter((block) => fold(block).includes(needle))
  }, [blocks, query])

  const willRun = checksToRun(project, checksSkip)
  // La carpeta de salida dicha en corto: la ruta entera es larga y lo que importa
  // es dónde cae dentro del proyecto (`docs/`, no la raíz).
  const relative =
    project && outputDir.startsWith(project.projectRoot)
      ? outputDir.slice(project.projectRoot.length).replace(/^\//, '') || '.'
      : outputDir

  return (
    <div className="overlay" onClick={onClose}>
      <div className="ai-modal requirements-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            Antes de empezar: {project ? project.projectRoot.split('/').pop() : 'el proyecto'}
          </h2>
          <button onClick={onClose} aria-label="Cerrar la ficha del proyecto">
            ×
          </button>
        </header>

        <div className="ai-body">
          <dl className="req-facts">
            <div>
              <dt>Proyecto</dt>
              <dd>
                <code>{project?.projectRoot ?? '(la carpeta de salida no está en uno)'}</code>
              </dd>
            </div>
            <div>
              <dt>Carpeta de salida</dt>
              <dd>
                <code>{relative || '(sin elegir)'}</code>
              </dd>
            </div>
            <div>
              <dt>Rama de trabajo</dt>
              <dd>
                <code>{branchOverride ?? repo?.branch ?? '(sin repositorio)'}</code>
              </dd>
            </div>
          </dl>

          <h3 className="req-title">Antes de registrar en Git</h3>
          {project?.checks.length ? (
            <>
              <ul className="req-checks">
                {project.checks.map((check) => (
                  <li key={check.script}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!checksSkip.includes(check.script)}
                        disabled={!verify}
                        onChange={() => toggleCheck(check.script)}
                      />
                      <span>
                        <code>npm run {check.script}</code> · {check.label}
                        <em>{check.detail}</em>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="git-note">
                {!verify ? (
                  <>
                    La comprobación está <b>desactivada</b> para todos los proyectos: se comitea sin
                    ejecutar nada.{' '}
                    <button className="link" onClick={() => setGit({ gitVerify: true })}>
                      Activarla
                    </button>
                  </>
                ) : willRun.length ? (
                  <>
                    Se ejecutan en ese orden y se para en el primero que falle. Si algo falla,{' '}
                    <b>no se comitea</b>: el paquete queda escrito y se puede corregir y volver a
                    guardar. Lo que desmarques aquí se recuerda para este proyecto.
                  </>
                ) : (
                  <>
                    No has dejado marcado ninguno, así que al registrar no se comprobará nada en
                    este proyecto.
                  </>
                )}
              </p>
            </>
          ) : (
            <p className="git-note">
              Este proyecto no tiene ninguno de los comandos que la app sabe ejecutar (
              <code>typecheck</code>, <code>lint:docs</code>, <code>build</code>), así que al
              registrar no se comprueba nada.
            </p>
          )}

          <h3 className="req-title">
            Cómo se escribe aquí
            {guide && guide !== 'loading' && (
              <button
                className="link"
                title={guide.path}
                onClick={() => void ipc.invoke('shell:open-path', guide.path)}
              >
                Abrir {guide.path.split('/').pop()}
              </button>
            )}
          </h3>

          {guide === 'loading' && <p className="muted">Leyendo el repositorio…</p>}
          {guide === null && (
            <p className="git-note">
              Este repositorio no tiene guía de estilo (<code>CONTRIBUTING.md</code> y compañía) en
              la raíz del proyecto ni en la del repositorio. Si su equipo tiene reglas de redacción,
              escribirlas ahí las pone delante de quien documenta —y de <code>lint:docs</code>— en
              vez de dejarlas en la cabeza de alguien.
            </p>
          )}
          {guide && guide !== 'loading' && (
            <>
              <div className="req-search">
                <input
                  type="search"
                  value={query}
                  placeholder="Buscar en las reglas (guion, emoji, avisos…)"
                  onChange={(e) => setQuery(e.target.value)}
                />
                <span className="muted">
                  {query.trim()
                    ? `${shown.length} de ${blocks.length} apartado(s)`
                    : `${blocks.length} apartado(s)`}
                </span>
              </div>
              {guide.truncated && (
                <p className="git-note">
                  La guía es enorme: aquí se muestra solo su principio. Ábrela para leerla entera.
                </p>
              )}
              {shown.length === 0 ? (
                <p className="muted">Ningún apartado menciona eso.</p>
              ) : (
                <div
                  className="req-guide markdown"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(shown.join('\n\n')) }}
                />
              )}
            </>
          )}
        </div>

        <footer>
          <label className="intro-remember">
            <input
              type="checkbox"
              checked={!onStart}
              onChange={(e) => setOnStart(!e.target.checked)}
            />
            <span>No mostrarla al empezar una guía</span>
          </label>
          <button className="btn primary" onClick={onClose}>
            Entendido
          </button>
        </footer>
      </div>
    </div>
  )
}
