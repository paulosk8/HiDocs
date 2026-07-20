import type { Page } from 'playwright-core'

/** Ventana de silencio del DOM que se considera «layout estable» (§5). */
const QUIET_MS = 300
/** Techo absoluto: nunca se retrasa una captura más que esto. */
const MAX_WAIT_MS = 1500

/**
 * Espera a que el efecto de la interacción haya terminado antes de capturar.
 *
 * En Next.js el resultado de un clic puede tardar: hidratación, transición de
 * ruta del App Router, o un modal que se monta en un portal con animación. Si se
 * captura en el instante del evento, la pantalla no muestra lo que el paso
 * documenta.
 *
 * Se combinan dos señales y gana la primera:
 *  - Silencio del DOM: 300 ms sin mutaciones (MutationObserver).
 *  - Red inactiva.
 *
 * `networkidle` por sí solo no sirve como carrera: en una navegación cliente sin
 * peticiones ya está satisfecho y resolvería al instante, justo el problema que
 * se quiere evitar. Por eso el silencio del DOM siempre aporta su ventana mínima
 * de 300 ms, y la red solo puede acortar la espera larga, no saltársela.
 */
export async function waitForStability(page: Page): Promise<void> {
  const domQuiet = page
    .evaluate(
      ([quietMs, maxMs]) =>
        new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>
          const observer = new MutationObserver(() => {
            clearTimeout(timer)
            timer = setTimeout(finish, quietMs)
          })
          const finish = (): void => {
            clearTimeout(timer)
            clearTimeout(cap)
            observer.disconnect()
            resolve()
          }
          const cap = setTimeout(finish, maxMs)
          timer = setTimeout(finish, quietMs)
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
          })
        }),
      [QUIET_MS, MAX_WAIT_MS] as const
    )
    .catch(() => undefined)

  const networkIdle = page
    .waitForLoadState('networkidle', { timeout: MAX_WAIT_MS })
    // Aun con la red parada, el navegador necesita un frame para repintar.
    .then(() => new Promise((r) => setTimeout(r, QUIET_MS)))
    .catch(() => undefined)

  const hardCap = new Promise((r) => setTimeout(r, MAX_WAIT_MS + QUIET_MS))

  await Promise.race([domQuiet, networkIdle, hardCap])
}
