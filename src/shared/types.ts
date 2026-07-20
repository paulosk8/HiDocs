/**
 * Modelo de datos del grabador (§6 de SPEC.md).
 * Este archivo es compartido por main, preload y renderer: no debe importar
 * nada de Node ni del DOM.
 */

export type StepAction = 'click' | 'fill' | 'select' | 'submit' | 'press' | 'navigate'

export type SelectorStrategy = 'testid' | 'id' | 'role' | 'text' | 'css'

export interface SelectorCandidate {
  strategy: SelectorStrategy
  value: string
  /** 0-100, robustez estimada. Mayor = más estable frente a cambios de UI. */
  score: number
}

export interface BoundingRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DocStep {
  id: string
  order: number
  action: StepAction
  title: string
  description: string
  selectorCandidates: SelectorCandidate[]
  /** para fill/select ("***" si es password) */
  value?: string
  /** metadato: URL en el momento de la interacción */
  url: string
  /** ruta relativa dentro del paquete exportado: img/paso-03.png */
  screenshot: string
  boundingRect: BoundingRect
  /** false = paso solo de navegación, no se documenta */
  includeInDocs: boolean
  timestamp: string
}

export interface Viewport {
  width: number
  height: number
}

export interface DocSession {
  id: string
  module: string
  feature: string
  title: string
  /** rol del usuario que ejecuta el flujo */
  role: string
  baseUrl: string
  viewport: Viewport
  createdAt: string
  steps: DocStep[]
}

export interface SessionMeta {
  module: string
  feature: string
  title: string
  role: string
  baseUrl: string
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 }

/** Estado del motor de grabación, reflejado en el indicador de la barra superior. */
export type RecorderStatus = 'idle' | 'recording' | 'paused'

export interface EngineState {
  status: RecorderStatus
  /** true cuando Playwright está adjunto al viewport vía CDP */
  attached: boolean
  /** URL actual del viewport */
  url: string
  /** último error del motor, si lo hubo */
  error?: string
}

/**
 * Insumo del runner futuro (§7): solo acciones + selectores, sin textos
 * editoriales ni rutas de imágenes.
 */
export interface FlowAction {
  order: number
  action: StepAction
  selectorCandidates: SelectorCandidate[]
  value?: string
  url: string
}

export interface Flow {
  sessionId: string
  module: string
  feature: string
  baseUrl: string
  viewport: Viewport
  actions: FlowAction[]
}

export interface SaveResult {
  /** carpeta final: <root>/<module>/<feature> */
  path: string
  stepsWritten: number
  imagesWritten: number
}
