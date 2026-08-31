/**
 * Zoom del visor (§19): la escala de pasos y las operaciones sobre ella.
 *
 * Vive en `shared` porque main la aplica (`setZoomFactor`) y el renderer la
 * dibuja (el porcentaje de la barra), y con dos escalas distintas el número que
 * se enseña dejaría de corresponderse con lo que se ve.
 *
 * Los valores son los de Chromium, no una progresión propia: son los que el
 * usuario ya conoce de su navegador, y así ⌘+ dentro del visor y ⌘+ en Chrome
 * dan el mismo salto.
 */
export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3
] as const

export const DEFAULT_ZOOM = 1
export const MIN_ZOOM = ZOOM_STEPS[0]
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]

/** Margen para comparar factores en coma flotante (0.1 + 0.2 y esas cosas). */
const EPSILON = 0.001

/**
 * Deja el factor dentro de la escala. Un valor ilegible —un `localStorage`
 * editado a mano, una versión anterior— vuelve al 100 % en vez de dejar el
 * visor a una escala imposible de la que no se sale.
 */
export function clampZoom(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return DEFAULT_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor))
}

/**
 * Siguiente paso de la escala en esa dirección. Si el factor actual cae entre
 * dos pasos (lo deja así una versión anterior o el zoom por rueda de Chromium),
 * salta al que toca, no al de al lado del más próximo.
 */
export function stepZoom(factor: number, direction: 'in' | 'out'): number {
  const current = clampZoom(factor)
  if (direction === 'in') {
    return ZOOM_STEPS.find((step) => step > current + EPSILON) ?? MAX_ZOOM
  }
  return [...ZOOM_STEPS].reverse().find((step) => step < current - EPSILON) ?? MIN_ZOOM
}

/** El número que se enseña en la barra: 0.67 → 67. */
export function zoomPercent(factor: number): number {
  return Math.round(clampZoom(factor) * 100)
}
