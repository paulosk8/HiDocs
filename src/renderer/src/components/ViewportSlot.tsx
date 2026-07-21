import { useEffect, useRef } from 'react'
import { ipc } from '../ipc'

/**
 * Hueco que reserva el layout para el `WebContentsView`.
 *
 * El renderer no dibuja nada aquí: solo mide el rectángulo y se lo reporta a
 * main, que posiciona la vista nativa encima. Por eso el borde y el texto de
 * ayuda quedan por debajo y solo se ven mientras no hay página cargada.
 */
export function ViewportSlot({ hint }: { hint: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const report = (): void => {
      const rect = node.getBoundingClientRect()
      void ipc.invoke('viewport:set-bounds', {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
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
  }, [])

  return (
    <div className="viewport-slot" ref={ref}>
      <p className="viewport-hint">{hint}</p>
    </div>
  )
}
