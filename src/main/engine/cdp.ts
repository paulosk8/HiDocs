import { chromium, type Browser, type Page } from 'playwright-core'
import { randomUUID } from 'node:crypto'

/**
 * Adjunta Playwright al `WebContentsView` del sistema documentado vía CDP (§2).
 *
 * Electron arranca con `--remote-debugging-port`, así que su endpoint expone un
 * target por cada `webContents`. El reto es distinguir cuál de esos targets es
 * el viewport y cuál la propia GUI: los ids de target de CDP no se corresponden
 * con los `webContents.id` de Electron.
 *
 * La identificación se hace plantando un marcador único desde el lado Electron
 * (`executeJavaScript`) y buscando desde el lado Playwright la página que lo ve.
 * Es exacto y no depende de heurísticas sobre URLs.
 */
export interface CdpAttachment {
  browser: Browser
  page: Page
}

const CONNECT_TIMEOUT_MS = 15_000

async function waitForEndpoint(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(
    `El endpoint CDP no respondió en el puerto ${port}: ${lastError instanceof Error ? lastError.message : 'timeout'}`
  )
}

export async function attachToViewport(
  port: number,
  targetWebContents: Electron.WebContents
): Promise<CdpAttachment> {
  await waitForEndpoint(port, CONNECT_TIMEOUT_MS)

  const marker = `doc-${randomUUID()}`
  // El marcador vive en el mundo principal del viewport solo el tiempo que dura
  // la búsqueda; se limpia en cuanto se identifica la página.
  await targetWebContents.executeJavaScript(`window.__docRecorderMarker=${JSON.stringify(marker)}`)

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    timeout: CONNECT_TIMEOUT_MS
  })

  try {
    const pages = browser.contexts().flatMap((ctx) => ctx.pages())
    for (const page of pages) {
      let found: string | undefined
      try {
        found = await page.evaluate<string | undefined>('window.__docRecorderMarker')
      } catch {
        // Páginas de la GUI o targets sin contexto de scripting: se ignoran.
        continue
      }
      if (found === marker) {
        await page.evaluate('delete window.__docRecorderMarker').catch(() => undefined)
        return { browser, page }
      }
    }
    throw new Error(
      'No se encontró el target CDP del viewport. ¿La vista está cargada? ' +
        `(${pages.length} páginas inspeccionadas)`
    )
  } catch (err) {
    await browser.close().catch(() => undefined)
    throw err
  }
}
