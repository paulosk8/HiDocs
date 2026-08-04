import { htmlToMarkdown } from './html-to-markdown'

/**
 * Lo que llega pegado, normalizado (§12).
 *
 * Pegar tiene dos entradas —la tecla (un `ClipboardEvent`, que ya trae los datos)
 * y el botón (que no tiene evento y pregunta al proceso principal)— y una sola
 * decisión: si hay imagen se documenta la imagen, y si no, el texto se convierte
 * en un bloque de contenido. Esa decisión vive aquí, no en cada entrada, para que
 * las dos se comporten igual.
 */

/**
 * ¿El foco está en algo donde pegar significa «pegar texto aquí»?
 *
 * Dentro de un título, una descripción o un bloque de contenido, pegar es lo que
 * siempre ha sido; la tarjeta nueva solo se crea cuando el pegado no tiene otro
 * destino. Sin esta distinción, pegar una tabla en un bloque de contenido crearía
 * además un bloque suelto.
 */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable === true
}

/** Imagen del portapapeles en un evento de pegado, o `null` si no traía ninguna. */
export function imageBlobFrom(data: DataTransfer | null): Blob | null {
  if (!data) return null
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

/** El contenido del archivo como data URI, sin pasar por `blob:` (ver abajo). */
function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Imagen (de cualquier formato) → data URI PNG.
 *
 * El paso siempre guarda PNG: es lo que produce el motor, lo que espera
 * `capture:save-edited` y lo que ya trae casi siempre el portapapeles, así que lo
 * habitual es no recodificar nada. Lo que llega en otro formato pasa por un
 * lienzo, que de paso descarta lo que el navegador no sabe decodificar en vez de
 * escribir un archivo ilegible.
 *
 * Nada de `URL.createObjectURL`: la política de seguridad de la ventana solo
 * admite imágenes `self`, `data:` y `docshot:`, y un `blob:` se bloquearía antes
 * de llegar a decodificarse. Por eso se lee el archivo como data URI.
 */
export async function pngDataUrl(blob: Blob): Promise<string | null> {
  try {
    const dataUrl = await readAsDataUrl(blob)
    if (dataUrl.startsWith('data:image/png;base64,')) return dataUrl

    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx || !canvas.width || !canvas.height) return null
    ctx.drawImage(image, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/**
 * Texto del portapapeles → cuerpo de un bloque de contenido, o `''` si no había
 * nada aprovechable.
 *
 * Se prefiere el HTML cuando aporta estructura: copiar la tabla de estados de un
 * sistema y que llegue como tabla Markdown es justo el caso que hace útil pegar
 * aquí. Es la misma conversión que hace el editor de contenido al pegar dentro.
 */
export function contentFromText(text: string, html: string): string {
  const markdown = html.trim() ? htmlToMarkdown(html) : null
  return (markdown ?? text).trim()
}
