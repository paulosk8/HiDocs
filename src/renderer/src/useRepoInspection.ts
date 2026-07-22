import { useEffect, useRef } from 'react'
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
 *
 * Además **retoma la rama en la que quedó el repositorio**: si al abrir la app el
 * clon está en una rama de documentación, esa pasa a ser la rama de trabajo y sus
 * metadatos (módulo, rol, URL base) se recuperan de lo que ya documenta. Es el
 * caso normal de volver al día siguiente a seguir con lo mismo, y evita tener que
 * reescribir la cabecera entera para acabar en la rama donde ya se estaba.
 */
export function useRepoInspection(): void {
  const outputDir = useSession((s) => s.outputDir)
  const setGitRepo = useSession((s) => s.setGitRepo)
  // Solo se retoma una vez por repositorio: si el usuario elige después otra
  // rama, o vacía el módulo, no se le vuelve a imponer la de HEAD.
  const adopted = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void ipc.invoke('git:inspect', outputDir).then(async (info) => {
        if (cancelled) return
        setGitRepo(info)
        if (!info || adopted.current === info.root) return

        const state = useSession.getState()
        // No se toca nada si ya hay trabajo en marcha: una elección previa, una
        // grabación en curso o unos metadatos escritos mandan sobre HEAD. Y una
        // rama por defecto (`main`) no dice nada sobre qué se estaba documentando.
        const idle =
          !state.gitBranchOverride &&
          !state.meta.module.trim() &&
          state.steps.length === 0 &&
          info.branch !== info.defaultBranch &&
          info.branch !== 'HEAD'
        adopted.current = info.root
        if (!idle) return

        const docs = await ipc.invoke('git:branch-docs', {
          repoRoot: info.root,
          branch: info.branch
        })
        // Sin documentación previa no hay nada que recuperar: la rama podría ser
        // de otra cosa (una rama de código del repositorio) y adoptarla a ciegas
        // llevaría el commit a un sitio que el usuario no ha pedido.
        if (cancelled || !docs.length) return
        // Sin activar el registro en Git: heredar la rama es una comodidad, y
        // decidir que se comitea sigue siendo del usuario.
        useSession.getState().adoptBranch(info.branch, docs[0], false)
      })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [outputDir, setGitRepo])
}
