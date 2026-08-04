import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserWindow,
  clipboard,
  desktopCapturer,
  nativeImage,
  screen,
  systemPreferences
} from 'electron'
import type { CaptureSource, ClipboardPaste } from '../shared/ipc-contract'

/**
 * Imágenes que no salen del visor (§12): capturas de pantalla ajenas a la página
 * y lo que el usuario trae pegado desde el portapapeles.
 *
 * No todo lo que hay que documentar vive dentro del navegador: una plantilla de
 * Excel, un correo, el visor de PDF del sistema operativo o una ventana de otra
 * aplicación forman parte del proceso igual que la pantalla web. Esas capturas no
 * las puede tomar el motor —Playwright solo ve la página—, así que aquí se
 * recurre a `desktopCapturer`, que es lo que Electron ofrece para fotografiar una
 * pantalla o una ventana del sistema.
 *
 * La imagen se guarda en la misma carpeta temporal que las capturas grabadas, de
 * modo que a partir de ahí el paso viaja por el mismo camino que cualquier otro:
 * se ve en el panel por `docshot://`, se autoguarda en el borrador y se copia a
 * `img/paso-NN.png` al guardar.
 */

/** Tamaño de las miniaturas del selector de fuentes. */
const THUMB = { width: 320, height: 200 }

/**
 * Pantalla simulada para las pruebas de humo, como `DOCRECORDER_AI_FAKE` lo es
 * para el proveedor de IA. `desktopCapturer` depende de qué ventanas haya
 * abiertas y de un permiso del sistema que no se puede conceder desde una
 * prueba, así que sin esto el circuito completo (elegir → recortar → señalar →
 * paso → MDX) se quedaría sin cubrir. Solo se activa con la variable.
 */
function fakeImage(): Electron.NativeImage {
  const width = 480
  const height = 300
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      // Un degradado con una banda oscura: se distingue a simple vista si el
      // recorte se aplicó y sobre qué zona.
      const band = y > height / 3 && y < (2 * height) / 3
      pixels[i] = band ? 40 : 220 // B
      pixels[i + 1] = band ? 60 : 200 // G
      pixels[i + 2] = band ? 200 : 180 // R
      pixels[i + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height })
}

function fakeSources(): { sources: CaptureSource[] } {
  return {
    sources: [
      {
        id: 'screen:fake:0',
        name: 'Pantalla de prueba',
        kind: 'screen',
        thumbnail: fakeImage().toDataURL()
      }
    ]
  }
}

/**
 * Permiso de grabación de pantalla. macOS lo exige y no se puede pedir desde la
 * app: hay que concederlo en Ajustes del sistema y reiniciar. Se comprueba antes
 * de listar para poder explicarlo en vez de devolver una lista vacía sin motivo.
 */
export function screenPermissionError(): string | null {
  if (process.platform !== 'darwin') return null
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted' || status === 'not-determined') return null
  return (
    'macOS no permite grabar la pantalla a esta aplicación. Actívalo en Ajustes del sistema → ' +
    'Privacidad y seguridad → Grabación de pantalla, y vuelve a abrir HiDocs.'
  )
}

/** Tamaño en píxeles reales del monitor mayor: el techo de la captura. */
function maxPixelSize(): { width: number; height: number } {
  const displays = screen.getAllDisplays()
  const width = Math.max(...displays.map((d) => d.size.width * d.scaleFactor), 1920)
  const height = Math.max(...displays.map((d) => d.size.height * d.scaleFactor), 1080)
  return { width: Math.round(width), height: Math.round(height) }
}

/** Pantallas y ventanas disponibles, con miniatura para reconocerlas. */
export async function listCaptureSources(): Promise<{ sources: CaptureSource[]; error?: string }> {
  if (process.env['DOCRECORDER_CAPTURE_FAKE']) return fakeSources()
  const error = screenPermissionError()
  if (error) return { sources: [], error }

  const raw = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMB,
    fetchWindowIcons: false
  })

  const sources = raw
    // Una ventana sin nombre suele ser un elemento interno del sistema (barras,
    // menús flotantes): no aporta nada y ensucia la lista.
    .filter((source) => source.name.trim().length > 0)
    .map<CaptureSource>((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL()
    }))

  return { sources }
}

/**
 * Captura la fuente elegida y la escribe en `file`.
 *
 * Con `hideWindow` se oculta HiDocs mientras se dispara: al fotografiar una
 * pantalla completa, la propia ventana de la aplicación taparía justo lo que se
 * quiere documentar. Se vuelve a mostrar siempre, también si la captura falla.
 */
export async function captureSourceToFile(
  sourceId: string,
  file: string,
  hideWindow: boolean,
  window: BrowserWindow | null
): Promise<{ file?: string; error?: string }> {
  if (process.env['DOCRECORDER_CAPTURE_FAKE']) {
    await writeFile(file, fakeImage().toPNG())
    return { file }
  }
  const permission = screenPermissionError()
  if (permission) return { error: permission }

  const wasVisible = hideWindow && !!window?.isVisible()
  if (wasVisible && window) {
    window.hide()
    // Un respiro para que el compositor termine de retirar la ventana; sin él la
    // captura la pilla a medio desaparecer.
    await new Promise((resolve) => setTimeout(resolve, 350))
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: maxPixelSize(),
      fetchWindowIcons: false
    })
    const source = sources.find((s) => s.id === sourceId)
    if (!source || source.thumbnail.isEmpty()) {
      return { error: 'Esa pantalla o ventana ya no está disponible. Vuelve a elegirla.' }
    }
    await writeFile(file, source.thumbnail.toPNG())
    return { file }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (wasVisible && window) {
      window.show()
      window.focus()
    }
  }
}

/**
 * El portapapeles como fuente de un paso.
 *
 * Es el camino más corto para lo que ya está capturado en otra parte: un recorte
 * hecho con las teclas del sistema, un diagrama copiado de otra herramienta, la
 * tabla de un correo. En vez de obligar a guardar un archivo y luego importarlo,
 * se pega y ya.
 *
 * La imagen manda sobre el texto: cuando se copia algo de una hoja de cálculo o
 * de un navegador, el portapapeles suele traer ambas cosas, y quien pega una
 * captura espera la captura. El texto solo se usa cuando no hay imagen ninguna,
 * y entonces la GUI lo convierte en un bloque de contenido.
 */
export async function readClipboard(shotDir: string): Promise<ClipboardPaste> {
  try {
    // En las pruebas el portapapeles del sistema no es controlable (depende de lo
    // que tuviera copiado quien lanza la prueba), así que la misma variable que
    // simula `desktopCapturer` simula aquí una imagen pegada.
    const image = process.env['DOCRECORDER_CAPTURE_FAKE'] ? fakeImage() : clipboard.readImage()
    if (!image.isEmpty()) {
      const file = join(shotDir, `pegada-${randomUUID()}.png`)
      await writeFile(file, image.toPNG())
      return { file }
    }
    const text = clipboard.readText()
    const html = clipboard.readHTML()
    return { text, html }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
