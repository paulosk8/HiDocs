import { useEffect, useRef } from 'react'
import { ipc } from '../ipc'
import { useSession } from '../store'

/**
 * Hueco que reserva el layout para el `WebContentsView`.
 *
 * El renderer no dibuja la página: mide el rectángulo del hueco y se lo reporta
 * a main, que coloca la vista nativa encima. Con una salvedad importante para el
 * arranque: mientras no hay página (`viewportActive` es falso) se reporta un
 * rectángulo de área cero, de modo que la vista nativa —que cargó `about:blank`
 * y siempre se pinta sobre el HTML— no tape el estado inicial. Así el primer
 * arranque muestra una guía, no un rectángulo vacío.
 */
export function ViewportSlot(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const active = useSession((s) => s.viewportActive)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const report = (): void => {
      const rect = node.getBoundingClientRect()
      void ipc.invoke('viewport:set-bounds', {
        x: rect.left,
        y: rect.top,
        // Sin página, área cero: la vista nativa queda oculta y se ve el
        // onboarding del DOM que hay debajo.
        width: active ? rect.width : 0,
        height: active ? rect.height : 0
      })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    window.addEventListener('resize', report)
    window.addEventListener('scroll', report, true)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
    }
  }, [active])

  return (
    <div className="viewport-slot" ref={ref}>
      {!active && <ViewportOnboarding />}
    </div>
  )
}

/** Estado inicial: qué es la app y los tres pasos para empezar. */
function ViewportOnboarding(): React.JSX.Element {
  return (
    <div className="viewport-empty">
      <div className="ve-badge" aria-hidden>
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor">
          <rect x="3" y="4" width="18" height="14" rx="2" strokeWidth="1.6" />
          <path d="M3 8h18" strokeWidth="1.6" />
          <circle cx="5.6" cy="6" r="0.6" fill="currentColor" stroke="none" />
          <circle cx="7.8" cy="6" r="0.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="13" r="2.4" strokeWidth="1.6" />
        </svg>
      </div>
      <h2>Documenta un sistema web paso a paso</h2>
      <p className="ve-lead">
        Abre el sistema en el visor y graba tu recorrido: cada interacción se convierte en un paso
        con su captura y su selector.
      </p>
      <ol className="ve-steps">
        <li>
          <span className="ve-num">1</span>
          <span>
            Escribe la <b>URL</b> del sistema arriba y pulsa <b>Abrir</b>. Puedes iniciar sesión con
            normalidad: se conserva entre usos.
          </span>
        </li>
        <li>
          <span className="ve-num">2</span>
          <span>
            Elige la <b>carpeta de salida</b>, dentro del repositorio de documentación, para
            registrar el resultado en Git.
          </span>
        </li>
        <li>
          <span className="ve-num">3</span>
          <span>
            Pulsa <b>●</b> y navega: revisa, edita y ordena los pasos en el panel derecho antes de
            guardar.
          </span>
        </li>
      </ol>
    </div>
  )
}
