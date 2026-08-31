import { useState } from 'react'
import { ipc } from '../ipc'
import { useSession } from '../store'
import { slug } from '../../../shared/naming'
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, zoomPercent } from '../../../shared/zoom'
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
  const {
    meta,
    setMeta,
    outputDir,
    setOutputDir,
    status,
    currentUrl,
    error,
    applyEngineState,
    setProjectsOpen,
    setHelpOpen,
    setAiOpen,
    aiStatus,
    theme,
    toggleTheme,
    setViewportActive,
    viewportZoom,
    setViewportZoom,
    branchDocs
  } = useSession()
  const [opening, setOpening] = useState(false)

  // Autocompletado: lo ya documentado en la rama, para no fragmentar categorías
  // por variantes de slug (institucion / instituciones). Los módulos, todos; las
  // subcategorías, solo las del módulo que se está escribiendo.
  const knownModules = [...new Set(branchDocs.map((d) => d.module).filter(Boolean))].sort()
  const currentModuleSlug = slug(meta.module)
  const knownSubcategories = [
    ...new Set(
      branchDocs
        .filter((d) => d.subcategory && (!currentModuleSlug || d.module === currentModuleSlug))
        .map((d) => d.subcategory)
    )
  ].sort()

  /**
   * Zoom del visor (§18). Lo aplica el proceso principal sobre la vista nativa y
   * devuelve el factor que quedó: la GUI solo guarda ese número para enseñarlo,
   * así que teclado, rueda y botones no pueden acabar diciendo cosas distintas.
   */
  const zoom = async (action: 'in' | 'out' | 'reset'): Promise<void> => {
    setViewportZoom(await ipc.invoke('viewport:zoom', { action }))
  }

  const open = async (): Promise<void> => {
    const url = normalizeUrl(meta.baseUrl)
    if (!url) return
    setMeta({ baseUrl: url })
    setOpening(true)
    // Se muestra el visor de inmediato (aunque la carga tarde): así al pulsar
    // «Abrir» el onboarding da paso a la página en curso, no se queda plantado.
    setViewportActive(true)
    try {
      applyEngineState(await ipc.invoke('viewport:navigate', url))
    } catch (err) {
      // Si la navegación falla, se vuelve al estado inicial en vez de dejar un
      // visor activo pero vacío.
      setViewportActive(false)
      throw err
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
            list="known-modules"
            onChange={(e) => setMeta({ module: e.target.value })}
          />
          <datalist id="known-modules">
            {knownModules.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>
            Subcategoría <span className="field-optional">(opcional)</span>
          </span>
          <input
            value={meta.subcategory}
            placeholder="institucion"
            list="known-subcategories"
            title="Nivel intermedio del sidebar de Docusaurus; déjalo vacío para no usarlo. Elígelo del árbol al seleccionar la rama."
            onChange={(e) => setMeta({ subcategory: e.target.value })}
          />
          <datalist id="known-subcategories">
            {knownSubcategories.map((sc) => (
              <option key={sc} value={sc} />
            ))}
          </datalist>
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
        <div className="zoom-buttons" role="group" aria-label="Zoom del visor">
          <button
            title="Alejar el visor (⌘/Ctrl y −)"
            aria-label="Alejar el visor"
            disabled={viewportZoom <= MIN_ZOOM}
            onClick={() => void zoom('out')}
          >
            −
          </button>
          <button
            className={`zoom-level${viewportZoom === DEFAULT_ZOOM ? '' : ' zoom-level-set'}`}
            title="Zoom del visor: púlsalo para volver al 100 % (⌘/Ctrl y 0). Las capturas salen a esta escala."
            onClick={() => void zoom('reset')}
          >
            {zoomPercent(viewportZoom)}%
          </button>
          <button
            title="Acercar el visor (⌘/Ctrl y +)"
            aria-label="Acercar el visor"
            disabled={viewportZoom >= MAX_ZOOM}
            onClick={() => void zoom('in')}
          >
            +
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
        <button
          className="btn"
          onClick={() => setProjectsOpen(true)}
          title="Repositorios ya usados, sus ramas y su historial"
        >
          Proyectos…
        </button>
        <button
          className="btn btn-ai-settings"
          onClick={() => setAiOpen(true)}
          title={
            aiStatus?.ready
              ? 'Ajustes de la redacción con IA (clave configurada)'
              : 'Configura la clave para redactar los pasos con IA'
          }
        >
          IA{aiStatus?.ready ? ' ✓' : '…'}
        </button>
        <button
          className="btn btn-icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
          aria-label={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <button
          className="btn btn-icon"
          onClick={() => setHelpOpen(true)}
          title="Ayuda: cómo usar la aplicación"
          aria-label="Abrir la ayuda"
        >
          ?
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
