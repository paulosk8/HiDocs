import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright-core'
import { attachToViewport, type CdpAttachment } from './cdp'
import {
  EMIT_BINDING,
  OBSERVER_NAMESPACE,
  observerScript,
  type RawEvent,
  type ObserverConfig
} from './observer'
import { buildSelectorCandidates } from './selectors'
import { waitForStability } from './stability'
import type { RecordedStep } from '../../shared/ipc-contract'
import type { BoundingRect, EngineState, RecorderStatus, StepAction } from '../../shared/types'

export interface EngineHooks {
  onState: (state: EngineState) => void
  onStep: (step: RecordedStep) => void
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void
}

const OBSERVER_CONFIG: ObserverConfig = {
  bindingName: EMIT_BINDING,
  namespace: OBSERVER_NAMESPACE,
  submitDedupeMs: 500
}

/**
 * ¿El elemento es un campo donde se introduce un valor? Sirve para agrupar: un
 * clic en un campo (enfocarlo antes de escribir) es parte del formulario; un
 * clic en un botón de envío no lo es.
 */
function isFormField(signals: RawEvent['signals']): boolean {
  const tag = signals.tag
  if (tag === 'select' || tag === 'textarea') return true
  if (tag === 'input') {
    const type = (signals.type ?? 'text').toLowerCase()
    return !['submit', 'button', 'reset', 'image'].includes(type)
  }
  return false
}

/** Título por defecto de cada paso, editable después por el usuario. */
function defaultTitle(action: StepAction, event: RawEvent): string {
  const name = event.signals.accessibleName ?? event.signals.text ?? event.signals.placeholder
  const label = name ? `«${name}»` : `<${event.signals.tag}>`
  switch (action) {
    case 'click':
      return `Clic en ${label}`
    case 'fill':
      return `Escribir en ${label}`
    case 'select':
      return `Seleccionar ${event.value ? `«${event.value}»` : ''} en ${label}`.replace(/\s+/g, ' ')
    case 'submit':
      return `Enviar el formulario ${label}`
    case 'press':
      return `Pulsar Enter en ${label}`
    case 'navigate':
      return `Ir a ${event.url}`
  }
}

/**
 * Motor de grabación: mantiene la conexión Playwright con el viewport, inyecta
 * el observador y convierte cada interacción en un paso documentado.
 */
export class RecorderEngine {
  private attachment: CdpAttachment | null = null
  private status: RecorderStatus = 'idle'
  private lastError: string | undefined
  private observerInstalled = false
  private stepCount = 0
  private shotDir: string | null = null

  /**
   * Los eventos se procesan de uno en uno: cada paso implica esperar
   * estabilidad, pintar el overlay y capturar, y dos capturas simultáneas se
   * pisarían el resaltado.
   */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly port: number,
    private readonly tempRoot: string,
    private readonly hooks: EngineHooks
  ) {}

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.hooks.onLog(level, message)
  }

  get page(): Page | null {
    return this.attachment?.page ?? null
  }

  get state(): EngineState {
    const state: EngineState = {
      status: this.status,
      attached: this.attachment !== null,
      url: this.attachment?.page.url() ?? ''
    }
    if (this.lastError) state.error = this.lastError
    return state
  }

  private emitState(): void {
    this.hooks.onState(this.state)
  }

  /** Idempotente: si ya está adjunto, no reconecta. */
  async attach(targetWebContents: Electron.WebContents): Promise<void> {
    if (this.attachment) return
    try {
      this.attachment = await attachToViewport(this.port, targetWebContents)
      this.lastError = undefined

      const title = await this.attachment.page.title().catch(() => '(sin título)')
      this.log('info', `Motor adjunto al viewport — título: "${title}"`)

      this.attachment.browser.on('disconnected', () => {
        this.attachment = null
        this.observerInstalled = false
        this.status = 'idle'
        this.log('warn', 'Se perdió la conexión CDP con el viewport')
        this.emitState()
      })

      await this.installObserver()
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.log('error', `No se pudo adjuntar el motor: ${this.lastError}`)
    }
    this.emitState()
  }

  /**
   * Instala el observador. `addInitScript` lo deja registrado para toda
   * navegación futura, y la evaluación directa cubre el documento ya cargado.
   */
  private async installObserver(): Promise<void> {
    const page = this.attachment?.page
    if (!page || this.observerInstalled) return

    await page.exposeBinding(EMIT_BINDING, (_source, event: RawEvent) => {
      this.enqueue(event)
    })
    await page.addInitScript(observerScript, OBSERVER_CONFIG)
    await page.evaluate(observerScript, OBSERVER_CONFIG).catch((err: unknown) => {
      this.log('warn', `El observador no pudo instalarse en la página actual: ${String(err)}`)
    })

    // Tras una navegación completa el script se reinyecta solo, pero hay que
    // devolverle el estado de grabación que tenía.
    page.on('load', () => {
      if (this.status === 'recording') void this.setObserverEnabled(true)
    })

    this.observerInstalled = true
    this.log('info', 'Observador de interacciones instalado')
  }

  private async setObserverEnabled(enabled: boolean): Promise<void> {
    const page = this.attachment?.page
    if (!page) return
    await page
      .evaluate(
        ([ns, value]) => {
          const api = (window as unknown as Record<string, { setEnabled(v: boolean): void }>)[
            ns as string
          ]
          api?.setEnabled(value as boolean)
        },
        [OBSERVER_NAMESPACE, enabled] as const
      )
      .catch(() => undefined)
  }

  // --- control de la grabación ---

  async start(): Promise<void> {
    if (!this.attachment) throw new Error('El motor no está adjunto al viewport')
    if (this.status === 'recording') return
    if (!this.shotDir) {
      this.shotDir = join(this.tempRoot, `docrecorder-${randomUUID()}`)
      mkdirSync(this.shotDir, { recursive: true })
    }
    this.status = 'recording'
    await this.setObserverEnabled(true)
    this.log('info', 'Grabación iniciada')
    this.emitState()
  }

  async pause(): Promise<void> {
    if (this.status !== 'recording') return
    this.status = 'paused'
    await this.setObserverEnabled(false)
    this.log('info', 'Grabación en pausa')
    this.emitState()
  }

  async resume(): Promise<void> {
    if (this.status !== 'paused') return
    this.status = 'recording'
    await this.setObserverEnabled(true)
    this.log('info', 'Grabación reanudada')
    this.emitState()
  }

  /** Detiene la grabación y espera a que la cola termine de emitir pasos. */
  async stop(): Promise<void> {
    if (this.status === 'idle') return
    this.status = 'idle'
    await this.setObserverEnabled(false)
    await this.queue
    this.log('info', 'Grabación detenida')
    this.emitState()
  }

  /** Reinicia el contador de pasos: se llama al empezar una sesión nueva. */
  reset(): void {
    this.stepCount = 0
  }

  // --- captura de pasos ---

  private enqueue(event: RawEvent): void {
    this.queue = this.queue.then(() => this.processEvent(event)).catch(() => undefined)
  }

  private async processEvent(event: RawEvent): Promise<void> {
    const page = this.attachment?.page
    if (!page || this.status !== 'recording') return

    const order = ++this.stepCount
    try {
      // 1. Esperar a que el efecto de la interacción termine (§5).
      await waitForStability(page)

      // 2. Resaltar el elemento y recalcular su rectángulo.
      const freshRect = await page
        .evaluate(
          ([ns, ref, badge]) => {
            const api = (
              window as unknown as Record<
                string,
                { highlight(r: number, b: number): BoundingRect | null }
              >
            )[ns as string]
            return api ? api.highlight(ref as number, badge as number) : null
          },
          [OBSERVER_NAMESPACE, event.ref, order] as const
        )
        .catch(() => null)

      const boundingRect = (freshRect as BoundingRect | null) ?? event.boundingRect

      // 3. Capturar el viewport completo con el resaltado dibujado.
      const file = join(this.shotDir!, `step-${String(order).padStart(3, '0')}.png`)
      await page.screenshot({ path: file, type: 'png' })

      // 4. Quitar el overlay para no dejar rastro en el sistema documentado.
      await page
        .evaluate(
          ([ns, ref]) => {
            const api = (
              window as unknown as Record<
                string,
                { clearHighlight(): void; release(r: number): void }
              >
            )[ns as string]
            api?.clearHighlight()
            api?.release(ref as number)
          },
          [OBSERVER_NAMESPACE, event.ref] as const
        )
        .catch(() => undefined)

      const step: RecordedStep = {
        id: randomUUID(),
        order,
        action: event.action,
        title: defaultTitle(event.action, event),
        description: '',
        selectorCandidates: buildSelectorCandidates(event.signals),
        url: event.url,
        screenshot: `img/paso-${String(order).padStart(2, '0')}.png`,
        boundingRect,
        includeInDocs: true,
        timestamp: event.timestamp,
        tempFile: file,
        isFormField: isFormField(event.signals)
      }
      if (event.value !== undefined) {
        step.value = event.isPassword ? '***' : event.value
      }

      this.hooks.onStep(step)
    } catch (err) {
      this.stepCount--
      this.log('error', `No se pudo capturar el paso: ${err instanceof Error ? err.message : err}`)
    }
  }

  async detach(): Promise<void> {
    if (!this.attachment) return
    const { browser } = this.attachment
    this.attachment = null
    this.observerInstalled = false
    this.status = 'idle'
    await browser.close().catch(() => undefined)
    this.emitState()
  }

  /** Borra las capturas temporales de la sesión. */
  cleanup(): void {
    if (this.shotDir) {
      rmSync(this.shotDir, { recursive: true, force: true })
      this.shotDir = null
    }
  }
}
