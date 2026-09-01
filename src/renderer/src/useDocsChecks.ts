import { useEffect } from 'react'
import { ipc } from './ipc'
import { useSession } from './store'

/**
 * Mantiene en el store qué se puede comprobar en el proyecto de destino (§17).
 *
 * Como `useRepoInspection`, va en un componente SIEMPRE montado (App): guardar
 * consulta esto para saber si tiene que enseñar el diálogo de la comprobación, y
 * guardar funciona también con el panel colapsado.
 *
 * La carpeta se puede escribir a mano, así que se espera un poco antes de mirar
 * el disco por cada tecla.
 */
export function useDocsChecks(): void {
  const outputDir = useSession((s) => s.outputDir)
  const setDocsChecks = useSession((s) => s.setDocsChecks)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void ipc.invoke('checks:detect', outputDir).then((checks) => {
        if (!cancelled) setDocsChecks(checks)
      })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [outputDir, setDocsChecks])

  // Una vista previa puede sobrevivir a un reinicio de la GUI (el servidor vive
  // en el proceso principal): al montar se pregunta si hay una en marcha, para
  // no ofrecer «levantar» lo que ya está levantado.
  useEffect(() => {
    void ipc.invoke('preview:status').then((status) => {
      if (status.running && status.url) useSession.getState().setPreviewUrl(status.url)
    })
  }, [])
}
