import { useEffect, useState } from 'react'
import { useSession } from '../store'

/**
 * Aviso que aparece al iniciar la app con lo esencial para que la documentación
 * se vea en Docusaurus. Es el paso donde más gente se atasca (elegir la raíz en
 * vez de `docs/`, o no saber que hay que cambiar de rama para previsualizar), así
 * que se muestra por defecto y se puede silenciar para siempre.
 */
export function DocusaurusIntroModal(): React.JSX.Element {
  const dismiss = useSession((s) => s.dismissDocusaurusIntro)
  const setHelpOpen = useSession((s) => s.setHelpOpen)
  const [remember, setRemember] = useState(false)

  const close = (): void => dismiss(remember)

  useEffect(() => {
    // Se re-registra al cambiar `remember` para cerrar con el valor actual.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss(remember)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [remember, dismiss])

  return (
    <div className="overlay" onClick={close}>
      <div className="intro-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Cómo ver tu documentación en Docusaurus</h2>
        </header>

        <div className="intro-body">
          <ol className="help-steps">
            <li>
              Elige como <b>carpeta de salida</b> la carpeta <code>docs/</code> de tu proyecto
              Docusaurus, <b>no la raíz</b>. Docusaurus solo renderiza lo que está dentro de{' '}
              <code>docs/</code>.
            </li>
            <li>
              Al guardar, la documentación se comitea en una <b>rama nueva</b> (<code>docs/…</code>
              ). Para previsualizarla, quédate en esa rama y ejecuta <code>npm run start</code> en
              el repositorio, o fusiona su Pull Request a la rama principal.
            </li>
            <li>
              No necesitas configurar Docusaurus: la barra lateral es autogenerada y cada módulo
              aparece como una categoría.
            </li>
          </ol>
          <p className="intro-note">
            La app te avisará si la carpeta elegida es la raíz de un Docusaurus, con un atajo para
            cambiar a <code>docs/</code>.
          </p>
        </div>

        <footer>
          <label className="intro-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>No volver a mostrar este aviso</span>
          </label>
          <div className="intro-actions">
            <button
              className="btn"
              onClick={() => {
                dismiss(remember)
                setHelpOpen(true)
              }}
            >
              Ver ayuda completa
            </button>
            <button className="btn primary" onClick={close}>
              Entendido
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
