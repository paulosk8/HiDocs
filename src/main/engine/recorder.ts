import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CDPSession, ElementHandle, Page } from 'playwright-core'
import { attachToViewport, type CdpAttachment } from './cdp'
import {
  EMIT_BINDING,
  OBSERVER_NAMESPACE,
  observerScript,
  type GroupHighlightResult,
  type HighlightResult,
  type RawEvent,
  type ObserverConfig
} from './observer'
import { buildSelectorCandidates } from './selectors'
import { waitForStability } from './stability'
import { regenerateSession, type RegenStepResult } from './runner'
import type { GroupTarget, RecordedStep, StepFamily } from '../../shared/ipc-contract'
import type { DocSession, SelectorCandidate } from '../../shared/types'
import type { EngineState, RecorderStatus, StepAction } from '../../shared/types'

export interface EngineHooks {
  onState: (state: EngineState) => void
  onStep: (step: RecordedStep) => void
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** Acciones tras las que la página puede irse y llevarse el elemento señalado. */
const NAVIGATING_ACTIONS: StepAction[] = ['click', 'press', 'submit', 'navigate']

/** Espera máxima al localizar por selector un elemento cuyo nodo fue reemplazado. */
const LOCATE_MS = 400

/**
 * ¿Las dos URL son la misma pantalla? Solo se tolera la barra final: un
 * parámetro distinto ya es otra vista en la mayoría de las aplicaciones, y
 * capturar allí un grupo documentaría algo que no ocurrió ahí.
 */
function sameScreen(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '')
}

/**
 * Localiza un elemento probando sus selectores en orden, como hace el runner.
 * Se usa cuando la referencia del observador murió porque el framework reemplazó
 * el nodo: el campo sigue en la pantalla, pero es otro.
 */
async function locateElement(
  page: Page,
  candidates: SelectorCandidate[]
): Promise<ElementHandle<Element> | null> {
  for (const candidate of candidates) {
    try {
      const loc = page.locator(candidate.value).first()
      await loc.waitFor({ state: 'attached', timeout: LOCATE_MS })
      const handle = await loc.elementHandle({ timeout: LOCATE_MS })
      if (handle) return handle
    } catch {
      // siguiente candidato
    }
  }
  return null
}

const OBSERVER_CONFIG: ObserverConfig = {
  bindingName: EMIT_BINDING,
  namespace: OBSERVER_NAMESPACE,
  submitDedupeMs: 500
}

/**
 * Roles ARIA de controles que introducen un valor. Los diseños actuales rara vez
 * usan `<input type="checkbox">`: un interruptor suele ser un `<button
 * role="switch">` y un desplegable un `<div role="combobox">`. Sin mirar el rol,
 * esos controles se tratarían como botones cualquiera y romperían la agrupación
 * del formulario al que pertenecen.
 */
const FIELD_ROLES = [
  'checkbox',
  'switch',
  'radio',
  'combobox',
  'listbox',
  'textbox',
  'searchbox',
  'spinbutton',
  'slider'
]

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
  if (FIELD_ROLES.includes((signals.role ?? '').toLowerCase())) return true
  // El observador ya miró el DOM: el elemento pulsado puede ser la etiqueta o el
  // envoltorio de un control, no el control en sí.
  return signals.fieldControl === true
}

/** Roles ARIA que son una acción y no un campo: se agrupan entre ellos. */
const ACTION_ROLES = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio']

/**
 * Familia del control: qué clase de cosa se hizo. Es lo que decide qué se funde
 * solo en un paso, porque **solo se funde lo del mismo tipo**.
 *
 * La regla anterior era binaria (campo / no campo) y dejaba fuera dos casos que
 * aparecen en cualquier sistema real: varias **pestañas** seguidas y varios
 * **botones** seguidos (abrir un menú y elegir su opción, guardar y cerrar) son
 * un solo paso para quien lee, y quedaban como tarjetas sueltas.
 *
 * Que las familias no se mezclen es lo que conserva el corte natural del flujo:
 * el «Guardar» de un formulario sigue teniendo tarjeta propia —es otra familia—
 * y se une al formulario a mano si se quiere, que fue la decisión de julio.
 *
 * `null` = no se funde con nada (un envío, una tecla, una navegación).
 */
function familyOf(action: StepAction, signals: RawEvent['signals']): StepFamily | null {
  if (action === 'fill' || action === 'select') return 'field'
  if (action !== 'click') return null
  const role = (signals.role ?? '').toLowerCase()
  // El campo manda sobre el rol: un `<option>` de un desplegable, o el
  // envoltorio de un interruptor, son parte de dar un valor.
  if (isFormField(signals) || role === 'option') return 'field'
  if (role === 'tab') return 'tab'
  if (ACTION_ROLES.includes(role) || ['button', 'a', 'summary'].includes(signals.tag)) {
    return 'action'
  }
  return null
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
    default:
      // `capture` y `content` solo existen en los pasos que añade el usuario a
      // mano: el motor nunca los emite.
      return label
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
  /** Sesión CDP en crudo, para capturar sin esperar a navegaciones pendientes. */
  private cdp: CDPSession | null = null

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
      this.cdp = await this.attachment.page
        .context()
        .newCDPSession(this.attachment.page)
        .catch(() => null)
      this.lastError = undefined

      const title = await this.attachment.page.title().catch(() => '(sin título)')
      this.log('info', `Motor adjunto al viewport — título: "${title}"`)

      this.attachment.browser.on('disconnected', () => {
        this.attachment = null
        this.cdp = null
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

  /**
   * Carpeta temporal de las capturas de esta sesión, creándola si aún no existe.
   *
   * La usan también las capturas externas (pantalla, ventana o archivo): así
   * TODAS las imágenes del panel viven en el mismo sitio, se sirven por el mismo
   * protocolo y se limpian juntas al cerrar, aunque no las haya tomado el motor.
   */
  ensureShotDir(): string {
    if (!this.shotDir) {
      this.shotDir = join(this.tempRoot, `docrecorder-${randomUUID()}`)
      mkdirSync(this.shotDir, { recursive: true })
    }
    return this.shotDir
  }

  async start(): Promise<void> {
    if (!this.attachment) throw new Error('El motor no está adjunto al viewport')
    if (this.status === 'recording') return
    this.ensureShotDir()
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

  /**
   * Regenera las capturas de una funcionalidad re-ejecutando su flujo en el
   * visor autenticado (§ runner). Detiene la grabación primero y desactiva el
   * observador para no capturar las propias acciones del runner.
   */
  async regenerate(
    session: DocSession,
    targetDir: string,
    onProgress?: (result: RegenStepResult) => void
  ): Promise<RegenStepResult[]> {
    const page = this.attachment?.page
    if (!page) {
      throw new Error(
        'Abre el sistema en el visor e inicia sesión antes de regenerar: el runner reutiliza esa sesión.'
      )
    }
    if (this.status !== 'idle') await this.stop()
    await this.setObserverEnabled(false)
    this.log('info', `Regenerando capturas de ${session.module}/${session.feature}…`)
    const results = await regenerateSession(page, session, targetDir, onProgress)
    const failed = results.filter((r) => r.status === 'failed').length
    this.log(
      failed ? 'warn' : 'info',
      `Regeneración terminada: ${results.length - failed} ok, ${failed} fallido(s).`
    )
    return results
  }

  /** Reinicia el contador de pasos: se llama al empezar una sesión nueva. */
  reset(): void {
    this.stepCount = 0
  }

  // --- captura de pasos ---

  private enqueue(event: RawEvent): void {
    this.queue = this.queue.then(() => this.processEvent(event)).catch(() => undefined)
  }

  /**
   * Vuelve a capturar marcando VARIOS elementos a la vez, para un paso agrupado.
   * La GUI la llama tras fundir un campo nuevo, tras quitar uno y tras agrupar a
   * mano: la captura resultante muestra la pantalla con todos los elementos del
   * paso señalados, no solo el último.
   *
   * Devuelve la ruta del PNG nuevo, o `null` cuando la captura no mejoraría la
   * que ya tiene el paso —la página se fue, o no queda nada que marcar—; en ese
   * caso la GUI conserva la anterior, que sí ilustra lo que ocurrió.
   *
   * Se encola con los pasos normales: dos capturas simultáneas se pisarían el
   * resaltado.
   */
  captureGroup(targets: GroupTarget[], expectUrl?: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.queue = this.queue
        .then(() => this.doCaptureGroup(targets, expectUrl))
        .then(resolve, () => resolve(null))
    })
  }

  /**
   * Cuántas veces se reintenta cuando algo del grupo está tapado o
   * desvaneciéndose, y cuánto se espera entre intentos. Un desplegable o un menú
   * que se cierra tarda unos cientos de milisegundos en irse, y es justo cuando
   * la GUI pide esta captura.
   */
  private static readonly GROUP_RETRIES = 2
  private static readonly GROUP_RETRY_MS = 350

  private async doCaptureGroup(
    targets: GroupTarget[],
    expectUrl?: string
  ): Promise<string | null> {
    const page = this.attachment?.page
    if (!page || !this.shotDir || !targets.length) return null

    // La captura del grupo solo tiene sentido en la pantalla donde ocurrió. Si el
    // último paso navegó —guardar, cerrar sesión, un enlace—, capturar ahora
    // documentaría la pantalla siguiente y, además, pisaría la captura buena que
    // el motor ya tomó antes de que la página se fuera.
    if (expectUrl && !sameScreen(page.url(), expectUrl)) {
      this.log(
        'info',
        'Grupo: la página ya no es la del paso, se conserva su captura anterior.'
      )
      return null
    }

    // Las referencias mueren cuando el framework reemplaza el nodo (guardar un
    // formulario, redibujar una tabla). Para esos elementos se localiza el actual
    // con los selectores del paso, los mismos que usa el runner.
    const alive = await page
      .evaluate(
        ([ns, groups]) => {
          const api = (
            window as unknown as Record<string, { groupRefsAlive(g: number[][]): boolean[] }>
          )[ns as string]
          return api ? api.groupRefsAlive(groups as number[][]) : null
        },
        [OBSERVER_NAMESPACE, targets.map((t) => t.refs ?? [])] as const
      )
      .catch(() => null)

    const handles: (ElementHandle<Element> | null)[] = []
    for (const [index, target] of targets.entries()) {
      if (alive?.[index]) {
        handles.push(null)
        continue
      }
      handles.push(await locateElement(page, target.selectorCandidates ?? []))
    }

    let result: GroupHighlightResult | null = null
    try {
      for (let attempt = 0; attempt < RecorderEngine.GROUP_RETRIES; attempt++) {
        result = await page
          .evaluate(
            ({ ns, groups, fallbacks }) => {
              const api = (
                window as unknown as Record<
                  string,
                  {
                    highlightGroup(p: {
                      targets: { refs: number[]; fallback: Element | null }[]
                    }): GroupHighlightResult
                  }
                >
              )[ns]
              return api
                ? api.highlightGroup({
                    targets: groups.map((refs, i) => ({ refs, fallback: fallbacks[i] ?? null }))
                  })
                : null
            },
            {
              ns: OBSERVER_NAMESPACE,
              groups: targets.map((t) => t.refs ?? []),
              fallbacks: handles
            }
          )
          .catch(() => null)

        if (!result || !result.marked) return null
        // Nada tapado ni desvaneciéndose: la captura ya muestra lo que documenta.
        if (!result.blocked || attempt === RecorderEngine.GROUP_RETRIES - 1) break
        await this.clearHighlight(page)
        await new Promise((resolve) => setTimeout(resolve, RecorderEngine.GROUP_RETRY_MS))
      }

      if (!result?.marked) return null
      if (result.blocked) {
        this.log(
          'info',
          `Grupo: ${result.blocked} elemento(s) siguen tapados al capturar; el recuadro los marca sin aclarar el fondo.`
        )
      }
      // Si algo del grupo ya no está en la pantalla, la captura nueva NO mejora
      // la que el paso trae: se conserva la del último clic, que es la única que
      // muestra ese elemento. Es el caso de un menú —abrir «Ver» y elegir
      // «Editar» son un paso, pero al elegir el menú se cierra— y el de
      // cualquier control que desaparece al accionarlo. Capturar igualmente
      // dejaría el paso ilustrado con una pantalla donde no se ve lo que dice
      // que hay que pulsar.
      // Un elemento que se está yendo (el menú que se cierra al elegir su opción)
      // tampoco mejora reintentando: la captura buena es la del clic.
      if (result.fading) {
        this.log(
          'info',
          `Grupo: ${result.fading} elemento(s) se están desvaneciendo; se conserva la captura del último paso.`
        )
        return null
      }
      if (result.missing) {
        this.log(
          'info',
          `Grupo: ${result.missing} elemento(s) ya no están en la pantalla; se conserva la captura del último paso.`
        )
        return null
      }

      const file = join(this.shotDir, `group-${randomUUID()}.png`)
      try {
        await page.screenshot({ path: file, type: 'png' })
      } catch {
        return null
      }
      return file
    } finally {
      await this.clearHighlight(page)
      for (const handle of handles) await handle?.dispose().catch(() => undefined)
    }
  }

  private async clearHighlight(page: Page): Promise<void> {
    await page
      .evaluate((ns) => {
        const api = (window as unknown as Record<string, { clearHighlight(): void }>)[ns]
        api?.clearHighlight()
      }, OBSERVER_NAMESPACE)
      .catch(() => undefined)
  }

  /**
   * Captura inmediata, por CDP en crudo, para las acciones que pueden navegar.
   *
   * El resaltado ya lo dibujó el observador de forma síncrona al recibir el
   * clic, antes de que arrancara la navegación: una vez arranca, Chromium
   * aplaza la ejecución de scripts y sería imposible pintarlo (se midió:
   * `Runtime.evaluate` tardaba 900 ms y respondía ya sobre la página siguiente).
   *
   * Aquí solo se captura, que sí llega mientras la página anterior siga a la
   * vista —lo normal mientras el servidor responde—. Se usa la API CDP en crudo
   * y no la de Playwright porque esta espera a que termine toda navegación
   * pendiente, que es justo lo que hay que adelantar.
   */
  private async earlyShoot(file: string): Promise<boolean> {
    const cdp = this.cdp
    if (!cdp) return false
    try {
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
      writeFileSync(file, Buffer.from(shot.data, 'base64'))
      return true
    } catch {
      // La página se fue antes de que llegara: el paso sigue su curso normal.
      return false
    }
  }

  /**
   * Resalta los elementos, captura el viewport y quita el overlay.
   *
   * Devuelve el rectángulo del último elemento señalado —y si está
   * desvaneciéndose—, o `null` si no se pudo señalar ninguno (se fueron con un
   * cambio de página) o si la captura falló. El overlay se quita siempre; las
   * referencias NO se liberan, porque el paso puede fundirse después con los
   * siguientes y habrá que volver a marcarlo.
   */
  private async shoot(page: Page, refs: number[], file: string): Promise<HighlightResult | null> {
    const painted = await page
      .evaluate(
        ([ns, targets]) => {
          const api = (
            window as unknown as Record<string, { highlight(r: number[]): HighlightResult | null }>
          )[ns as string]
          return api ? api.highlight(targets as number[]) : null
        },
        [OBSERVER_NAMESPACE, refs] as [string, number[]]
      )
      .catch(() => null)

    let captured = true
    try {
      await page.screenshot({ path: file, type: 'png' })
    } catch {
      captured = false
    }
    await page
      .evaluate(
        (ns) => {
          const api = (window as unknown as Record<string, { clearHighlight(): void }>)[ns]
          api?.clearHighlight()
        },
        OBSERVER_NAMESPACE
      )
      .catch(() => undefined)

    return captured ? (painted as HighlightResult | null) : null
  }

  private async processEvent(event: RawEvent): Promise<void> {
    const page = this.attachment?.page
    if (!page || this.status !== 'recording') return

    const order = ++this.stepCount
    const file = join(this.shotDir!, `step-${String(order).padStart(3, '0')}.png`)
    const earlyFile = join(this.shotDir!, `step-${String(order).padStart(3, '0')}-previo.png`)
    try {
      // 1. Captura inmediata para las acciones que pueden navegar. «Cerrar
      //    sesión» se lleva por delante el menú que hay que señalar: al capturar
      //    después ya no queda nada que marcar y el paso ilustraba la pantalla
      //    siguiente, sin recuadro. Solo se usa si la definitiva no puede
      //    señalar el elemento.
      const early =
        NAVIGATING_ACTIONS.includes(event.action) && (await this.earlyShoot(earlyFile))

      // 2. Esperar a que el efecto de la interacción termine (§5).
      await waitForStability(page)

      // 3. Resaltar el elemento y recalcular su rectángulo, ya estabilizado.
      const fresh = await this.shoot(page, [event.ref], file)

      // La definitiva manda salvo que el elemento ya no exista —o esté
      // desvaneciéndose—; entonces vale más la previa, que sí lo muestra
      // legible, que una imagen de la pantalla nueva o de un menú medio borrado.
      const usePrevious = early && (!fresh || fresh.faded)
      const tempFile = usePrevious ? earlyFile : file
      const boundingRect = fresh?.rect ?? event.boundingRect
      if (usePrevious) {
        this.log(
          'info',
          fresh
            ? `Paso ${order}: el elemento se estaba desvaneciendo, se usa la captura previa al clic.`
            : `Paso ${order}: la página cambió al instante, se usa la captura previa al clic.`
        )
      }
      rmSync(usePrevious ? file : earlyFile, { force: true })

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
        tempFile,
        isFormField: isFormField(event.signals),
        family: familyOf(event.action, event.signals),
        ref: event.ref,
        loadRef: event.loadRef,
        rowRef: event.rowRef,
        tableRef: event.tableRef,
        cellRef: event.cellRef,
        colIndex: event.colIndex,
        colHeader: event.colHeader
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
