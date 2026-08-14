import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { shotUrl, type RecordedStep } from '../../../shared/ipc-contract'
import { useSession } from '../store'
import { useAiDraft } from '../useAiDraft'
import { ContentEditor } from './ContentEditor'
import { NoteEditor } from './NoteEditor'

/** Prefijo del id de la zona de soltar; lo reconoce `StepsPanel.onDragEnd`. */
export const GROUP_DROP_PREFIX = 'group-drop:'

/**
 * Carpeta de capturas (§17).
 *
 * Es UN paso del manual cuyas ilustraciones son varias: se le arrastran dentro
 * las tarjetas que cuentan lo mismo —los tres pantallazos de un asistente, la
 * pantalla y el correo que llega después— y se publican juntas bajo su título,
 * cada una con su pie.
 *
 * Se diferencia de ⊞ Agrupar en lo que conserva: agrupar funde acciones y deja
 * UNA captura (es un paso del flujo que el runner reproduce); la carpeta no toca
 * las acciones de nadie y conserva TODAS las imágenes. Por eso admite lo que
 * agrupar rechaza: capturas externas, imágenes pegadas y pasos que no están al
 * lado. Es la respuesta a documentar con capturas que el motor no graba.
 *
 * La tarjeta dibuja solo la cabecera y la zona de soltar: sus capturas son
 * tarjetas normales del panel, dibujadas debajo con sangría, para que sigan
 * siendo arrastrables y editables como cualquier otro paso.
 */
export function GroupCard({
  step,
  count,
  nested,
  badge
}: {
  step: RecordedStep
  /** cuántas capturas contiene */
  count: number
  /** la carpeta cuelga de una sección */
  nested?: boolean
  /** número del paso en el manual */
  badge: string
}): React.JSX.Element {
  const updateStep = useSession((s) => s.updateStep)
  const removeStep = useSession((s) => s.removeStep)
  const focusStepId = useSession((s) => s.focusStepId)
  const clearFocus = useSession((s) => s.clearFocus)
  const setActiveStep = useSession((s) => s.setActiveStep)
  const collapsed = useSession((s) => s.collapsedSections.includes(step.id))
  const toggleSection = useSession((s) => s.toggleSection)
  // Se selecciona la lista entera y se filtra aquí: un selector que devuelve un
  // array nuevo en cada lectura no es estable y deja a zustand re-renderizando
  // sin parar.
  const steps = useSession((s) => s.steps)
  const members = steps.filter((other) => other.groupId === step.id)
  const aiBusy = useSession((s) => s.aiBusyIds.includes(step.id))
  const setWideContentId = useSession((s) => s.setWideContentId)
  const { draft } = useAiDraft()

  const titleRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const [noteOpen, setNoteOpen] = useState(!!step.note?.body.trim())
  const [contentOpen, setContentOpen] = useState(!!step.content?.trim())

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id
  })
  // La zona de soltar es un destino propio, distinto de la tarjeta: soltar SOBRE
  // la carpeta la reordena (como cualquier paso) y soltar DENTRO mete la captura.
  // Sin esa separación no habría forma de mover un paso por delante de la carpeta
  // sin meterlo dentro.
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `${GROUP_DROP_PREFIX}${step.id}` })

  useEffect(() => {
    if (focusStepId !== step.id) return
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    if (document.hasFocus()) titleRef.current?.focus()
    clearFocus()
  }, [focusStepId, step.id, clearFocus])

  useLayoutEffect(() => {
    const el = descRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [step.description])

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        cardRef.current = node
      }}
      className={
        `group-card${isDragging ? ' dragging' : ''}${collapsed ? ' collapsed' : ''}` +
        `${nested ? ' nested' : ''}${step.includeInDocs ? '' : ' excluded'}`
      }
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onPointerDownCapture={() => setActiveStep(step.id)}
      onFocusCapture={() => setActiveStep(step.id)}
    >
      <div className="group-head">
        <button
          className="drag-handle"
          title="Arrastrar para mover la carpeta con sus capturas"
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <button
          className="section-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? 'Desplegar la carpeta' : 'Plegar la carpeta'}
          aria-label={`${collapsed ? 'Desplegar' : 'Plegar'} la carpeta ${step.title || 'sin título'}`}
          onClick={() => toggleSection(step.id)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="step-badge">{badge}</span>
        <span className="group-icon" aria-hidden="true">
          📁
        </span>
        <input
          ref={titleRef}
          className="group-title"
          value={step.title}
          placeholder="Título del paso ilustrado por estas capturas"
          onChange={(e) => updateStep(step.id, { title: e.target.value })}
        />
        <span className="section-count" title={`${count} captura(s) en esta carpeta`}>
          {count}
        </span>
        <button
          className="icon-btn ai-btn"
          disabled={aiBusy}
          title="Redactar el título y la descripción de la carpeta con IA"
          aria-label={`Redactar la carpeta ${step.title || 'sin título'} con IA`}
          onClick={() => void draft([step.id])}
        >
          {aiBusy ? '⋯' : '✨'}
        </button>
        <button
          className={`icon-btn content-btn${step.content?.trim() ? ' has-content' : ''}`}
          title="Añadir una tabla, un bloque de código u otro contenido de Docusaurus"
          aria-label={`Bloque de contenido de la carpeta ${step.title || 'sin título'}`}
          aria-pressed={contentOpen}
          onClick={() => setContentOpen((v) => !v)}
        >
          ▦
        </button>
        <button
          className={`icon-btn note-btn${step.note?.body.trim() ? ' has-note' : ''}`}
          title="Añadir una nota destacada (admonition de Docusaurus)"
          aria-label={`Nota de la carpeta ${step.title || 'sin título'}`}
          aria-pressed={noteOpen}
          onClick={() => setNoteOpen((v) => !v)}
        >
          📝
        </button>
        <button
          className="icon-btn danger"
          title="Quitar la carpeta (sus capturas se conservan, sueltas)"
          aria-label={`Quitar la carpeta ${step.title || 'sin título'}`}
          onClick={() => removeStep(step.id)}
        >
          ✕
        </button>
      </div>

      <textarea
        ref={descRef}
        className="group-desc"
        rows={1}
        value={step.description}
        placeholder="Qué muestran juntas estas capturas (opcional)"
        onChange={(e) => updateStep(step.id, { description: e.target.value })}
      />

      {contentOpen && (
        <div className="step-content">
          <ContentEditor
            value={step.content ?? ''}
            onChange={(content) => updateStep(step.id, { content })}
            onExpand={() => setWideContentId(step.id)}
          />
        </div>
      )}

      {noteOpen && (
        <div className="step-note">
          <NoteEditor value={step.note} onChange={(note) => updateStep(step.id, { note })} />
        </div>
      )}

      {/* Plegada, la carpeta enseña en miniatura lo que guarda: es lo que permite
          trabajar con una lista larga sin perder de vista qué hay dentro. */}
      {collapsed ? (
        <div className="group-strip">
          {members.map((member) =>
            member.tempFile ? (
              <img
                key={member.id}
                src={shotUrl(member.tempFile)}
                alt={member.title || 'Captura de la carpeta'}
                title={member.title}
              />
            ) : (
              <span key={member.id} className="group-strip-empty" title={member.title}>
                ▦
              </span>
            )
          )}
          {!members.length && <span className="muted">carpeta vacía</span>}
        </div>
      ) : (
        <div
          ref={setDropRef}
          className={`group-drop${isOver ? ' over' : ''}${count ? ' compact' : ''}`}
        >
          {count
            ? 'Suelta aquí otra tarjeta para añadirla a la carpeta'
            : 'Arrastra aquí las tarjetas cuyas capturas ilustran este paso'}
        </div>
      )}
    </div>
  )
}
