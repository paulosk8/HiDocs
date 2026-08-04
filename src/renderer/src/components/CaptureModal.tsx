import { useCallback, useEffect, useRef, useState } from 'react'
import { shotUrl, type CaptureSource } from '../../../shared/ipc-contract'
import { ipc } from '../ipc'

/**
 * Captura de algo que no está en el visor (§12): otra ventana, la pantalla
 * entera, el portapapeles o una imagen que ya existe en el disco.
 *
 * El proceso tiene dos momentos y por eso el diálogo tiene dos pantallas:
 *
 * 1. ELEGIR de dónde sale la imagen. Se listan pantallas y ventanas con su
 *    miniatura, porque «Pantalla 1» y «Pantalla 2» no significan nada sin verlas.
 * 2. AJUSTARLA antes de darla por buena. Casi nunca se documenta la pantalla
 *    entera: se recorta lo que importa y se señala con un recuadro el elemento
 *    del que se habla, igual que hace el motor con los elementos de la página.
 *    Así la captura externa se lee como una más del manual.
 *
 * Con `initial` se entra directamente en el segundo momento: es lo que hacen
 * «pegar y ajustar» —la imagen ya está en el portapapeles, no hay nada que
 * elegir— y el botón de ajustar la imagen de una tarjeta que ya existe.
 */

/** Color del resaltado; el mismo que pinta el observador sobre la página. */
const HIGHLIGHT = '#FF5722'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

type Tool = 'crop' | 'mark'

export function CaptureModal({
  onClose,
  onCaptured,
  initial = null,
  confirmLabel = 'Añadir como paso'
}: {
  onClose: () => void
  /** ruta del PNG ya editado, listo para convertirse en un paso */
  onCaptured: (file: string, sourceName: string) => void
  /** imagen con la que abrir, saltándose el selector de fuentes */
  initial?: { file: string; name: string } | null
  confirmLabel?: string
}): React.JSX.Element {
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hideWindow, setHideWindow] = useState(true)
  const [busy, setBusy] = useState(false)

  /** captura tomada, pendiente de ajustar */
  const [shot, setShot] = useState<{ file: string; name: string } | null>(initial)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [crop, setCrop] = useState<Rect | null>(null)
  const [marks, setMarks] = useState<Rect[]>([])
  const [tool, setTool] = useState<Tool>('crop')
  const [pending, setPending] = useState<Rect | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  /** cambia al pulsar «Actualizar»: vuelve a enumerar pantallas y ventanas */
  const [reloadKey, setReloadKey] = useState(0)

  // Solo se enumeran pantallas y ventanas cuando hay algo que elegir: abriendo
  // con una imagen ya puesta, listarlas costaría una comprobación de permisos y
  // un recorrido de ventanas que nadie va a mirar.
  useEffect(() => {
    if (shot) return
    let alive = true
    void ipc.invoke('capture:sources').then((result) => {
      if (!alive) return
      setSources(result.sources)
      if (result.error) setError(result.error)
    })
    return () => {
      alive = false
    }
  }, [reloadKey, shot])

  const reloadSources = (): void => {
    setSources(null)
    setError(null)
    setReloadKey((key) => key + 1)
  }

  /** Vuelve al selector de fuentes descartando la captura y sus ajustes. */
  const chooseAnother = useCallback((): void => {
    setShot(null)
    setImage(null)
    setCrop(null)
    setMarks([])
    setPending(null)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // La imagen se carga con CORS abierto (el protocolo `docshot` lo permite) para
  // poder recortarla en el lienzo y leer el resultado.
  useEffect(() => {
    if (!shot) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      setImage(img)
      setCrop({ x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight })
      setMarks([])
      setPending(null)
    }
    img.onerror = () => setError('No se pudo abrir la captura.')
    img.src = shotUrl(shot.file)
  }, [shot])

  /** Redibuja el lienzo: el recorte actual, los resaltados y el rectángulo en curso. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || !crop) return
    canvas.width = crop.width
    canvas.height = crop.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)

    // El grosor se escala con la imagen: 3 px sobre una captura 4K no se verían.
    const stroke = Math.max(3, Math.round(crop.width / 400))
    ctx.lineWidth = stroke
    ctx.strokeStyle = HIGHLIGHT
    for (const mark of marks) {
      ctx.strokeRect(mark.x - crop.x, mark.y - crop.y, mark.width, mark.height)
    }
    if (pending) {
      ctx.setLineDash([stroke * 2, stroke * 2])
      ctx.strokeStyle = tool === 'crop' ? '#2563eb' : HIGHLIGHT
      ctx.strokeRect(pending.x - crop.x, pending.y - crop.y, pending.width, pending.height)
      ctx.setLineDash([])
    }
  }, [image, crop, marks, pending, tool])

  /** Punto del ratón → coordenadas de la imagen original. */
  const toImage = (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas || !crop) return { x: 0, y: 0 }
    const box = canvas.getBoundingClientRect()
    const scaleX = crop.width / box.width
    const scaleY = crop.height / box.height
    return {
      x: crop.x + (e.clientX - box.left) * scaleX,
      y: crop.y + (e.clientY - box.top) * scaleY
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStart.current = toImage(e)
    setPending(null)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const start = dragStart.current
    if (!start) return
    const now = toImage(e)
    setPending({
      x: Math.min(start.x, now.x),
      y: Math.min(start.y, now.y),
      width: Math.abs(now.x - start.x),
      height: Math.abs(now.y - start.y)
    })
  }

  const onPointerUp = (): void => {
    dragStart.current = null
    // Un arrastre minúsculo suele ser un clic sin querer: no cuenta.
    if (pending && (pending.width < 8 || pending.height < 8)) setPending(null)
  }

  const applyPending = (): void => {
    if (!pending) return
    if (tool === 'crop') setCrop(pending)
    else setMarks((all) => [...all, pending])
    setPending(null)
  }

  const undo = (): void => {
    if (marks.length) setMarks((all) => all.slice(0, -1))
    else if (image) setCrop({ x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight })
  }

  const take = async (source: CaptureSource): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await ipc.invoke('capture:take', { sourceId: source.id, hideWindow })
      if (result.error) setError(result.error)
      else if (result.file) setShot({ file: result.file, name: source.name })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Imagen del portapapeles. Es la vía para lo que ya está capturado en otra
   * parte —el recorte hecho con las teclas del sistema, un diagrama copiado de
   * otra herramienta— y funciona igual pulsando el botón o pegando con el teclado
   * dentro del diálogo.
   */
  const fromClipboard = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const clip = await ipc.invoke('clipboard:read')
      if (clip.error) setError(clip.error)
      else if (clip.file) setShot({ file: clip.file, name: 'Imagen pegada' })
      else setError('El portapapeles no tiene ninguna imagen. Copia una y vuelve a pegar.')
    } finally {
      setBusy(false)
    }
  }, [])

  // Pegar con el teclado hace lo mismo que el botón, también con una imagen ya
  // cargada: es la forma natural de cambiarla por otra sin volver al selector.
  useEffect(() => {
    const onPaste = (): void => void fromClipboard()
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [fromClipboard])

  const fromFile = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await ipc.invoke('capture:import-file')
      if (result.error) setError(result.error)
      else if (result.file) setShot({ file: result.file, name: 'Imagen' })
    } finally {
      setBusy(false)
    }
  }

  /** Compone recorte + resaltados y lo guarda como captura de la sesión. */
  const confirm = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas || !shot) return
    setBusy(true)
    try {
      const file = await ipc.invoke('capture:save-edited', canvas.toDataURL('image/png'))
      if (!file) {
        setError('No se pudo guardar la captura editada.')
        return
      }
      onCaptured(file, shot.name)
    } finally {
      setBusy(false)
    }
  }

  const screens = sources?.filter((s) => s.kind === 'screen') ?? []
  const windows = sources?.filter((s) => s.kind === 'window') ?? []

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog capture-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{shot ? 'Ajusta la imagen' : 'Captura de pantalla'}</h3>

        {error && <p className="git-note warn">{error}</p>}

        {!shot ? (
          <>
            <p className="muted">
              Documenta lo que no está en el visor: otra ventana, el escritorio, lo que tengas
              copiado o una imagen que ya tengas guardada.
            </p>

            <div className="capture-options">
              <label title="Al capturar una pantalla completa, HiDocs se aparta para no salir en la imagen">
                <input
                  type="checkbox"
                  checked={hideWindow}
                  onChange={(e) => setHideWindow(e.target.checked)}
                />
                ocultar HiDocs mientras captura
              </label>
              <button
                className="btn"
                disabled={busy}
                title="Usa la imagen que tengas copiada (⌘/Ctrl+V también funciona aquí)"
                onClick={() => void fromClipboard()}
              >
                📋 Pegar del portapapeles
              </button>
              <button className="btn" disabled={busy} onClick={() => void fromFile()}>
                🖼 Imagen desde archivo…
              </button>
              <button className="btn" disabled={busy} onClick={reloadSources}>
                ↻ Actualizar
              </button>
            </div>

            {sources === null ? (
              <p className="muted">Buscando pantallas y ventanas…</p>
            ) : (
              <div className="capture-sources">
                {[
                  { label: 'Pantallas', items: screens },
                  { label: 'Ventanas', items: windows }
                ].map((group) =>
                  group.items.length ? (
                    <section key={group.label}>
                      <h4>{group.label}</h4>
                      <div className="capture-grid">
                        {group.items.map((source) => (
                          <button
                            key={source.id}
                            className="capture-source"
                            disabled={busy}
                            title={source.name}
                            onClick={() => void take(source)}
                          >
                            {source.thumbnail ? (
                              <img src={source.thumbnail} alt="" />
                            ) : (
                              <span className="capture-noshot">sin vista previa</span>
                            )}
                            <span className="capture-name">{source.name}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="capture-tools" role="toolbar" aria-label="Herramientas de la captura">
              <button
                className={`btn${tool === 'crop' ? ' primary' : ''}`}
                onClick={() => setTool('crop')}
                title="Arrastra sobre la imagen para elegir la zona y pulsa «Aplicar»"
              >
                ✂ Recortar
              </button>
              <button
                className={`btn${tool === 'mark' ? ' primary' : ''}`}
                onClick={() => setTool('mark')}
                title="Arrastra para señalar el elemento del que habla el paso"
              >
                ▭ Señalar
              </button>
              <button className="btn" disabled={!pending} onClick={applyPending}>
                Aplicar
              </button>
              <button className="btn" disabled={!marks.length && !image} onClick={undo}>
                ↩ Deshacer
              </button>
              <span className="muted capture-hint">
                {tool === 'crop'
                  ? 'Arrastra la zona que quieres conservar.'
                  : 'Arrastra sobre lo que hay que mirar.'}
              </span>
            </div>

            <div className="capture-canvas-wrap">
              <canvas
                ref={canvasRef}
                className="capture-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              />
            </div>
          </>
        )}

        <div className="dialog-actions">
          {shot && (
            <button className="btn" disabled={busy} onClick={chooseAnother}>
              Elegir otra
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          {shot && (
            <button
              className="btn primary"
              disabled={busy || !image}
              onClick={() => void confirm()}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
