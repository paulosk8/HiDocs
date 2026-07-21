import { BaseWindow, WebContentsView, session } from 'electron'
import type { ViewportBounds } from '../shared/ipc-contract'
import type { Viewport } from '../shared/types'

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
    if (visible) {
      this.setBounds(this.lastBounds)
    } else {
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
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
