import { useCallback, useState } from 'react'
import { ipc } from './ipc'
import { contentFromText, imageBlobFrom, pngDataUrl } from './paste-step'
import { useSession } from './store'

/**
 * Pegar como forma de documentar (§12).
 *
 * Documentando de verdad, mucho de lo que hay que dejar dicho ya está copiado en
 * el portapapeles: el recorte que se acaba de hacer con las teclas del sistema, un
 * diagrama de otra herramienta, la tabla de estados de un correo. Este gancho lo
 * convierte en una tarjeta más —con su título, su nota destacada y su bloque de
 * contenido, como cualquier paso— sin pasar por guardar un archivo e importarlo.
 *
 * Lo que aparece depende de lo que haya en el portapapeles:
 *
 * - una imagen → un paso `image`, con la imagen ya guardada en la sesión;
 * - texto → un bloque de contenido, con las tablas ya convertidas a Markdown.
 *
 * Y siempre justo debajo de la tarjeta en la que se está trabajando, que es donde
 * se espera lo que acompaña al paso que se acaba de grabar.
 */
export function usePasteStep(): {
  /**
   * Pega desde un evento de teclado. Devuelve `true` si se hizo cargo del pegado
   * (y entonces quien llama debe cancelar el evento), `false` si no había nada
   * que documentar.
   */
  pasteFromEvent: (data: DataTransfer | null) => Promise<boolean>
  /** Pega leyendo el portapapeles del sistema (botón, sin evento de por medio). */
  pasteFromClipboard: () => Promise<void>
  /** motivo por el que el último pegado no produjo nada, para avisar */
  problem: string | null
  clearProblem: () => void
} {
  const addManualStep = useSession((s) => s.addManualStep)
  const [problem, setProblem] = useState<string | null>(null)

  /** Guarda la imagen en la sesión y crea su tarjeta. */
  const addImage = useCallback(
    async (dataUrl: string): Promise<boolean> => {
      // El mismo canal que usa el editor de capturas: escribe el PNG en la
      // carpeta de capturas de la sesión, de donde ya lo recogen el borrador, el
      // paquete guardado y el MDX.
      const file = await ipc.invoke('capture:save-edited', dataUrl)
      if (!file) {
        setProblem('No se pudo guardar la imagen pegada.')
        return false
      }
      addManualStep({ kind: 'image', title: 'Imagen pegada', tempFile: file })
      return true
    },
    [addManualStep]
  )

  const addContent = useCallback(
    (markdown: string): boolean => {
      if (!markdown) return false
      addManualStep({ kind: 'content', title: '', content: markdown })
      return true
    },
    [addManualStep]
  )

  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    const clip = await ipc.invoke('clipboard:read')
    if (clip.error) {
      setProblem(clip.error)
      return
    }
    if (clip.file) {
      addManualStep({ kind: 'image', title: 'Imagen pegada', tempFile: clip.file })
      return
    }
    if (addContent(contentFromText(clip.text ?? '', clip.html ?? ''))) return
    setProblem(
      'El portapapeles está vacío. Copia una imagen (o una tabla, o un texto) y vuelve a pegar.'
    )
  }, [addManualStep, addContent])

  const pasteFromEvent = useCallback(
    async (data: DataTransfer | null): Promise<boolean> => {
      const blob = imageBlobFrom(data)
      if (blob) {
        const dataUrl = await pngDataUrl(blob)
        if (!dataUrl) {
          setProblem('Eso que hay en el portapapeles no se pudo leer como imagen.')
          return true
        }
        return addImage(dataUrl)
      }

      const text = data?.getData('text/plain') ?? ''
      const html = data?.getData('text/html') ?? ''
      if (text.trim() || html.trim()) return addContent(contentFromText(text, html))

      // Hay pegados que no llegan en el evento (según el sistema y la aplicación
      // de origen): antes de dar el portapapeles por vacío se pregunta al proceso
      // principal, que lo lee de otra manera.
      const clip = await ipc.invoke('clipboard:read')
      if (clip.file) {
        addManualStep({ kind: 'image', title: 'Imagen pegada', tempFile: clip.file })
        return true
      }
      return addContent(contentFromText(clip.text ?? '', clip.html ?? ''))
    },
    [addContent, addImage, addManualStep]
  )

  return {
    pasteFromEvent,
    pasteFromClipboard,
    problem,
    clearProblem: useCallback(() => setProblem(null), [])
  }
}
