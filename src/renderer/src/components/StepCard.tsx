import { useEffect, useLayoutEffect, useRef } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { shotUrl, type RecordedStep } from '../../../shared/ipc-contract'
import { useSession } from '../store'

const STRATEGY_LABEL: Record<string, string> = {
  testid: 'test-id',
  id: 'id',
  role: 'rol',
  text: 'texto',
  css: 'css'
}

const ACTION_LABEL: Record<string, string> = {
  click: 'clic',
  fill: 'escribir',
  select: 'seleccionar',
  submit: 'enviar',
  press: 'tecla',
  navigate: 'navegar'
}

interface Props {
  step: RecordedStep
  onOpenShot: (step: RecordedStep) => void
}

export function StepCard({ step, onOpenShot }: Props): React.JSX.Element {
  const updateStep = useSession((s) => s.updateStep)
  const removeStep = useSession((s) => s.removeStep)
  const focusStepId = useSession((s) => s.focusStepId)
  const clearFocus = useSession((s) => s.clearFocus)

  const titleRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id
  })

  // Al llegar un paso nuevo durante la grabación: scroll y foco en el título,
  // para poder describirlo al vuelo sin tocar el ratón (§8).
  //
  // El foco solo se toma si la GUI ya lo tenía. Si el usuario está dentro del
  // sistema documentado, robárselo rompería la grabación: lo que teclease a
  // continuación acabaría en este campo en vez de en el formulario, y ese paso
  // `fill` nunca llegaría a registrarse.
  useEffect(() => {
    if (focusStepId !== step.id) return
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    if (document.hasFocus()) {
      titleRef.current?.focus()
      titleRef.current?.select()
    }
    clearFocus()
  }, [focusStepId, step.id, clearFocus])

  // Textarea que crece con el contenido.
  useLayoutEffect(() => {
    const el = descRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [step.description])

  const preferred = step.selectorCandidates[0]

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        cardRef.current = node
      }}
      className={`step-card${isDragging ? ' dragging' : ''}${step.includeInDocs ? '' : ' excluded'}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="step-head">
        <button
          className="drag-handle"
          title="Arrastrar para reordenar"
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <span className="step-badge">{step.order}</span>
        <span className="action-chip">{ACTION_LABEL[step.action] ?? step.action}</span>
        <button
          className="icon-btn danger"
          title="Eliminar paso"
          onClick={() => removeStep(step.id)}
        >
          ✕
        </button>
      </div>

      <div className="step-body">
        <button
          className="thumb"
          title="Ver la captura a tamaño real"
          onClick={() => onOpenShot(step)}
        >
          <img src={shotUrl(step.tempFile)} alt={`Captura del paso ${step.order}`} />
        </button>

        <div className="step-fields">
          <input
            ref={titleRef}
            className="step-title"
            value={step.title}
            placeholder="Título del paso"
            onChange={(e) => updateStep(step.id, { title: e.target.value })}
          />
          <textarea
            ref={descRef}
            className="step-desc"
            rows={2}
            value={step.description}
            placeholder="Descripción (opcional)"
            onChange={(e) => updateStep(step.id, { description: e.target.value })}
          />
        </div>
      </div>

      {step.value !== undefined && (
        <div className="step-value">
          valor: <code>{step.value}</code>
        </div>
      )}

      <div className="step-foot">
        {preferred ? (
          <span
            className={`selector-chip strategy-${preferred.strategy}`}
            title={step.selectorCandidates
              .map((c) => `${c.strategy} (${c.score}): ${c.value}`)
              .join('\n')}
          >
            <b>{STRATEGY_LABEL[preferred.strategy] ?? preferred.strategy}</b>
            <code>{preferred.value}</code>
            <i>{preferred.score}</i>
          </span>
        ) : (
          <span className="selector-chip missing">sin selector</span>
        )}
        <label className="include-toggle" title="Excluir los pasos que solo sirven para navegar">
          <input
            type="checkbox"
            checked={step.includeInDocs}
            onChange={(e) => updateStep(step.id, { includeInDocs: e.target.checked })}
          />
          incluir en docs
        </label>
      </div>
    </div>
  )
}
