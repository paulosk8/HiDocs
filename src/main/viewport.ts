import { BaseWindow, WebContentsView, session } from 'electron'
import type { ViewportBounds } from '../shared/ipc-contract'
import type { Viewport } from '../shared/types'
import { DEFAULT_ZOOM, clampZoom, stepZoom } from '../shared/zoom'

/** Partición persistente: conserva el login del sistema documentado entre usos (§9). */
const TARGET_PARTITION = 'persist:target-app'

/**
 * Envoltorio del `WebContentsView` donde vive el sistema web que se documenta.
 *
 * El renderer no puede tocar esta vista: solo reporta el rectángulo del hueco
 * que le reservó en su layout, y main la posiciona ahí.
 */
export class TargetViewport {
  private view: WebContentsView | null = null
  private window: BaseWindow | null = null
  private lastBounds: ViewportBounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = true

  /** Tamaño real que ocupa la vista; se persiste en la sesión como `viewport`. */
  private size: Viewport = { width: 0, height: 0 }

  /** Escala del contenido del visor (§19); la GUI la enseña en porcentaje. */
  private zoom = DEFAULT_ZOOM

  attachTo(window: BaseWindow): void {
    this.window = window
    this.view = new WebContentsView({
      webPreferences: {
        // El sistema documentado nunca recibe acceso a Node (§9).
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: TARGET_PARTITION
      }
    })
    this.view.setBackgroundColor('#ffffff')
    window.contentView.addChildView(this.view)
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })

    // Imprescindible: un WebContentsView que nunca cargó nada no tiene proceso
    // renderer, y su target CDP acepta la conexión pero no responde a ningún
    // comando. Playwright espera a que TODAS las páginas se inicialicen, así que
    // `connectOverCDP` se colgaría. Cargar about:blank le da un renderer vivo.
    void this.view.webContents.loadURL('about:blank')

    // El zoom de Chromium es por origen: al navegar a otro dominio la página
    // arranca al 100 % y el porcentaje de la barra pasaría a mentir. Se reaplica
    // en cada carga, que es lo que hace que el ajuste sea del visor y no de la
    // página que toque estar viendo.
    const wc = this.view.webContents
    const reapply = (): void => {
      if (Math.abs(wc.getZoomFactor() - this.zoom) > 0.001) wc.setZoomFactor(this.zoom)
    }
    wc.on('did-navigate', reapply)
    wc.on('did-frame-finish-load', reapply)
  }

  get webContents(): Electron.WebContents | null {
    return this.view?.webContents ?? null
  }

  get currentSize(): Viewport {
    return { ...this.size }
  }

  get url(): string {
    return this.view?.webContents.getURL() ?? ''
  }

  /**
   * Coloca la vista en el hueco reportado por la GUI. Los valores llegan en
   * píxeles CSS del renderer y se redondean: `setBounds` exige enteros.
   */
  setBounds(bounds: ViewportBounds): void {
    this.lastBounds = bounds
    if (!this.view) return
    const rect = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    if (this.visible) {
      this.view.setBounds(rect)
      this.size = { width: rect.width, height: rect.height }
    }
  }

  /**
   * Oculta la vista sin destruirla (la sesión y el DOM siguen vivos). Se usa
   * cuando la GUI abre un modal encima: un `WebContentsView` siempre se pinta
   * por encima del contenido HTML del renderer, así que no basta con z-index.
   */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (!this.view) return
    // Se oculta en el compositor con `view.setVisible`, no solo con bounds 0×0:
    // con un diálogo nativo del sistema encima (p. ej. el selector de carpeta),
    // el tamaño 0×0 dejaba el último fotograma pintado y la vista tapaba la barra
    // superior de la GUI. `setVisible(false)` la retira de verdad.
    this.view.setVisible(visible)
    if (visible) {
      this.setBounds(this.lastBounds)
    } else {
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }

  get currentZoom(): number {
    return this.zoom
  }

  /**
   * Fija la escala del contenido del visor y devuelve la que quedó (puede no ser
   * la pedida: la escala tiene tope arriba y abajo). Es el único camino por el
   * que se cambia el zoom —botones, teclado y rueda pasan por aquí—, para que el
   * porcentaje que enseña la barra sea siempre el de la vista.
   */
  setZoom(factor: number): number {
    this.zoom = clampZoom(factor)
    this.view?.webContents.setZoomFactor(this.zoom)
    return this.zoom
  }

  /** Un paso de la escala hacia arriba o hacia abajo (§19). */
  stepZoom(direction: 'in' | 'out'): number {
    return this.setZoom(stepZoom(this.zoom, direction))
  }

  async navigate(url: string): Promise<void> {
    if (!this.view) throw new Error('El viewport no está inicializado')
    await this.view.webContents.loadURL(url)
  }

  goBack(): void {
    const wc = this.view?.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  goForward(): void {
    const wc = this.view?.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(): void {
    this.view?.webContents.reload()
  }

  /** Limpia la partición persistente (logout del sistema documentado). */
  static async clearSession(): Promise<void> {
    await session.fromPartition(TARGET_PARTITION).clearStorageData()
  }

  destroy(): void {
    if (this.view && this.window) {
      this.window.contentView.removeChildView(this.view)
      this.view.webContents.close()
      this.view = null
    }
  }
}
