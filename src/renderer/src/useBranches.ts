import { useEffect, useState } from 'react'
import type { GitBranchInfo } from '../../shared/types'
import { ipc } from './ipc'

/**
 * Ramas locales del repositorio de la sesión, compartidas por la franja de
 * estado, el selector de rama y la sección Git.
 *
 * Listar ramas no es gratis (`listBranches` cuenta los commits que cada una
 * lleva por delante de la rama por defecto: un proceso `git` por rama), y esos
 * tres sitios las piden a la vez. Por eso hay una caché fuera de React —y una
 * tabla de peticiones en vuelo, para que montar dos componentes a la vez no
 * lance dos consultas— en vez de un estado por componente.
 *
 * La contrapartida de cachear es quedarse con una lista vieja justo cuando más
 * importa: al comitear nace una rama. Por eso la caché se invalida a mano en los
 * dos momentos en que puede haber cambiado —después de guardar y al abrir el
 * selector— en vez de confiar en que algún dato del store se mueva solo.
 */
const cache = new Map<string, GitBranchInfo[]>()
const inflight = new Map<string, Promise<GitBranchInfo[]>>()
const subscribers = new Set<() => void>()
let version = 0

/** Descarta lo cacheado y hace que todos los que las muestran vuelvan a leerlas. */
export function invalidateBranches(): void {
  cache.clear()
  version++
  subscribers.forEach((notify) => notify())
}

function load(root: string): Promise<GitBranchInfo[]> {
  const running = inflight.get(root)
  if (running) return running
  const promise = ipc
    .invoke('git:branches', root)
    .then((items) => {
      cache.set(root, items)
      return items
    })
    .finally(() => inflight.delete(root))
  inflight.set(root, promise)
  return promise
}

export function useBranches(root: string | undefined): GitBranchInfo[] | null {
  // Lo último recibido, con la raíz que lo pidió. La caché manda sobre él: este
  // estado solo existe para repintar cuando la consulta responde.
  const [data, setData] = useState<{ root: string; items: GitBranchInfo[] } | null>(null)
  const [seen, setSeen] = useState(version)

  useEffect(() => {
    const notify = (): void => setSeen(version)
    subscribers.add(notify)
    return () => {
      subscribers.delete(notify)
    }
  }, [])

  useEffect(() => {
    if (!root || cache.has(root)) return
    let cancelled = false
    void load(root).then((items) => {
      if (!cancelled) setData({ root, items })
    })
    return () => {
      cancelled = true
    }
    // `seen` está en las dependencias a propósito: es lo que reintenta la lectura
    // cuando la caché se invalida.
  }, [root, seen])

  if (!root) return null
  // Mientras se recarga se sigue enseñando lo anterior: es casi correcto y
  // parpadear a «cargando» en cada guardado es peor.
  return cache.get(root) ?? (data?.root === root ? data.items : null)
}
