import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { RecordedStep } from '../../../shared/ipc-contract'
import { useSession } from '../store'

/**
 * Separador de sección: el título de un apartado del manual (§8).
 *
 * No documenta nada por sí mismo. Existe para que una grabación larga se pueda
 * leer y manejar por partes: los pasos que van debajo cuelgan de él hasta la
 * sección siguiente, se pliegan con un clic y se arrastran en bloque (mover un
 * apartado de doce pasos era, hasta ahora, doce arrastres). En el manual sale
 * como encabezado `##`, con los pasos por debajo como `###`.
 *
 * Se dibuja aparte de `StepCard` a propósito: casi ninguno de los controles de un
 * paso tiene sentido aquí (no hay captura que ver, ni selector, ni nota, ni
 * agrupación), y colarlos apagados solo haría ruido.
 */
export function SectionCard({
  step,
  /** cuántos pasos cuelgan de esta sección */
  count
}: {
  step: RecordedStep
  count: number
}): React.JSX.Element {
  const updateStep = useSession((s) => s.updateStep)
  const removeStep = useSession((s) => s.removeStep)
  const focusStepId = useSession((s) => s.focusStepId)
  const clearFocus = useSession((s) => s.clearFocus)
  const setActiveStep = useSession((s) => s.setActiveStep)
  const collapsed = useSession((s) => s.collapsedSections.includes(step.id))
  const toggleSection = useSession((s) => s.toggleSection)

  const titleRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const introRef = useRef<HTMLTextAreaElement>(null)
  // La entradilla es opcional y estorba en la mayoría de secciones, así que solo
  // se muestra si ya tiene texto o si se pide con su botón.
  const [introOpen, setIntroOpen] = useState(!!step.description.trim())

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id
  })

  // Igual que un paso recién grabado: la sección recién creada se enfoca para
  // poder titularla al vuelo, sin tocar el ratón.
  useEffect(() => {
    if (focusStepId !== step.id) return
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    if (document.hasFocus()) titleRef.current?.focus()
    clearFocus()
  }, [focusStepId, step.id, clearFocus])

  useLayoutEffect(() => {
    const el = introRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [step.description, introOpen])

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        cardRef.current = node
      }}
      className={`section-card${isDragging ? ' dragging' : ''}${collapsed ? ' collapsed' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onPointerDownCapture={() => setActiveStep(step.id)}
      onFocusCapture={() => setActiveStep(step.id)}
    >
      <div className="section-head">
        <button
          className="drag-handle"
          title="Arrastrar para mover la sección con sus pasos"
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <button
          className="section-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? 'Desplegar la sección' : 'Plegar la sección'}
          aria-label={`${collapsed ? 'Desplegar' : 'Plegar'} la sección ${step.title || 'sin título'}`}
          onClick={() => toggleSection(step.id)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <input
          ref={titleRef}
          className="section-title"
          value={step.title}
          placeholder="Título de la sección"
          onChange={(e) => updateStep(step.id, { title: e.target.value })}
        />
        <span className="section-count" title={`${count} paso(s) en esta sección`}>
          {count}
        </span>
        <button
          className={`icon-btn${step.description.trim() ? ' has-content' : ''}`}
          title="Entradilla de la sección (un párrafo antes de sus pasos)"
          aria-label={`Entradilla de la sección ${step.title || 'sin título'}`}
          aria-pressed={introOpen}
          onClick={() => setIntroOpen((v) => !v)}
        >
          ¶
        </button>
        <button
          className="icon-btn danger"
          title="Quitar la sección (sus pasos se conservan)"
          aria-label={`Quitar la sección ${step.title || 'sin título'}`}
          onClick={() => removeStep(step.id)}
        >
          ✕
        </button>
      </div>

      {introOpen && (
        <textarea
          ref={introRef}
          className="section-intro"
          rows={1}
          value={step.description}
          placeholder="Entradilla de la sección (opcional): qué se consigue en este apartado"
          onChange={(e) => updateStep(step.id, { description: e.target.value })}
        />
      )}
    </div>
  )
}
