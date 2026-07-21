import { useState } from 'react'
import { ipc } from '../ipc'
import { useSession } from '../store'
import type { RecorderStatus } from '../../../shared/types'

const STATUS_LABEL: Record<RecorderStatus, string> = {
  idle: 'Listo',
  recording: 'Grabando',
  paused: 'Pausado'
}

/** Normaliza lo que escriba el usuario: `midominio.com` → `https://midominio.com`. */
function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function TopBar(): React.JSX.Element {
  const { meta, setMeta, outputDir, setOutputDir, status, currentUrl, error, applyEngineState } =
    useSession()
  const [opening, setOpening] = useState(false)

  const open = async (): Promise<void> => {
    const url = normalizeUrl(meta.baseUrl)
    if (!url) return
    setMeta({ baseUrl: url })
    setOpening(true)
    try {
      applyEngineState(await ipc.invoke('viewport:navigate', url))
    } finally {
      setOpening(false)
    }
  }

  const pickDir = async (): Promise<void> => {
    const dir = await ipc.invoke('dialog:pick-output-dir')
    if (dir) setOutputDir(dir)
  }

  return (
    <header className="topbar">
      <div className="topbar-row">
        <label className="field">
          <span>Módulo</span>
          <input
            value={meta.module}
            placeholder="matriculas"
            onChange={(e) => setMeta({ module: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Funcionalidad</span>
          <input
            value={meta.feature}
            placeholder="crear-matricula"
            onChange={(e) => setMeta({ feature: e.target.value })}
          />
        </label>
        <label className="field field-wide">
          <span>Título</span>
          <input
            value={meta.title}
            placeholder="Crear una matrícula"
            onChange={(e) => setMeta({ title: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Rol</span>
          <input
            value={meta.role}
            placeholder="secretaria"
            onChange={(e) => setMeta({ role: e.target.value })}
          />
        </label>
        <div className={`status status-${status}`}>
          <span className="status-dot" />
          {STATUS_LABEL[status]}
        </div>
      </div>

      <div className="topbar-row">
        <div className="nav-buttons">
          <button title="Atrás" onClick={() => void ipc.invoke('viewport:back')}>
            ‹
          </button>
          <button title="Adelante" onClick={() => void ipc.invoke('viewport:forward')}>
            ›
          </button>
          <button title="Recargar" onClick={() => void ipc.invoke('viewport:reload')}>
            ⟳
          </button>
        </div>
        <label className="field field-grow">
          <span>URL base</span>
          <input
            value={meta.baseUrl}
            placeholder="https://sistema.ejemplo.com"
            onChange={(e) => setMeta({ baseUrl: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void open()
            }}
          />
        </label>
        <button className="btn" disabled={opening} onClick={() => void open()}>
          {opening ? 'Abriendo…' : 'Abrir'}
        </button>

        <label className="field field-grow">
          <span>Carpeta de salida</span>
          {/* Editable a propósito: pegar una ruta es más rápido que navegar el
              selector nativo cuando siempre se documenta en el mismo sitio. */}
          <input
            value={outputDir}
            placeholder="Sin seleccionar"
            onChange={(e) => setOutputDir(e.target.value)}
          />
        </label>
        <button className="btn" onClick={() => void pickDir()}>
          Elegir…
        </button>
      </div>

      {(currentUrl || error) && (
        <div className="topbar-meta">
          {error ? (
            <span className="error">{error}</span>
          ) : (
            <span className="current-url" title={currentUrl}>
              {currentUrl}
            </span>
          )}
        </div>
      )}
    </header>
  )
}
