import { useEffect } from 'react'
import { ipc } from './ipc'
import { useSession } from './store'

/**
 * Mantiene `gitRepo` en el store al día con la carpeta de salida.
 *
 * Debe invocarse en un componente SIEMPRE montado (App), no en la sección Git ni
 * en el panel de pasos: esos se desmontan al colapsar el panel, y entonces la
 * franja de estado se quedaría sin repositorio que mostrar.
 *
 * La carpeta se puede escribir a mano, así que la inspección se retrasa para no
 * lanzar un proceso `git` por cada tecla.
 */
export function useRepoInspection(): void {
  const outputDir = useSession((s) => s.outputDir)
  const setGitRepo = useSession((s) => s.setGitRepo)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void ipc.invoke('git:inspect', outputDir).then((info) => {
        if (!cancelled) setGitRepo(info)
      })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [outputDir, setGitRepo])
}
