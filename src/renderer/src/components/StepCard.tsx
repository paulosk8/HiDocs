import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { shotUrl, type RecordedStep } from '../../../shared/ipc-contract'
import { useSession } from '../store'
import { useAiDraft } from '../useAiDraft'
import { useGroupCapture } from '../useGroupCapture'
import { ContentEditor } from './ContentEditor'
import { NoteEditor } from './NoteEditor'

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
  navigate: 'navegar',
  capture: 'captura externa',
  image: 'imagen',
  content: 'contenido'
}

interface Props {
  step: RecordedStep
  /** el paso cuelga de una sección: se sangra para que se vea de quién es */
  nested?: boolean
  /**
   * Lo que se muestra en la chapa del paso. Normalmente su número; dentro de una
   * carpeta, «5·2», porque el paso del manual es la carpeta y esta captura es la
   * segunda de las suyas.
   */
  badge?: string
  /** el paso está dentro de una carpeta de capturas */
  inGroup?: boolean
  onOpenShot: (step: RecordedStep) => void
  /** abre el editor de recorte y resaltado sobre la imagen que ya tiene el paso */
  onAdjustImage: (step: RecordedStep) => void
}

export function StepCard({
  step,
  nested,
  badge,
  inGroup,
  onOpenShot,
  onAdjustImage
}: Props): React.JSX.Element {
  const updateStep = useSession((s) => s.updateStep)
  const removeStep = useSession((s) => s.removeStep)
  const focusStepId = useSession((s) => s.focusStepId)
  const clearFocus = useSession((s) => s.clearFocus)
  const setActiveStep = useSession((s) => s.setActiveStep)
  const aiBusy = useSession((s) => s.aiBusyIds.includes(step.id))
  const removeGroupField = useSession((s) => s.removeGroupField)
  const ungroupStep = useSession((s) => s.ungroupStep)
  const selected = useSession((s) => s.selectedIds.includes(step.id))
  const toggleSelect = useSession((s) => s.toggleSelect)
  const setWideContentId = useSession((s) => s.setWideContentId)
  const removeFromGroup = useSession((s) => s.removeFromGroup)
  const { draft } = useAiDraft()
  const recaptureGroup = useGroupCapture()

  /** Cómo se nombra este paso en los textos de ayuda y en las etiquetas ARIA. */
  const label = badge ?? String(step.order)

  const titleRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  // La nota y el bloque de contenido se abren solos si el paso ya los trae
  // (borrador restaurado), y a petición con su botón; así no estorban en los
  // pasos que no los usan.
  const [noteOpen, setNoteOpen] = useState(!!step.note?.body.trim())
  const [contentOpen, setContentOpen] = useState(step.kind === 'content' || !!step.content?.trim())

  const isContent = step.kind === 'content'
  const isCapture = step.kind === 'capture'
  const isImage = step.kind === 'image'
  const isManual = isContent || isCapture || isImage

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
  const setContent = (content: string): void => updateStep(step.id, { content })

  return (
    <div
      ref={(node) => {
        setNodeRef(node)
        cardRef.current = node
      }}
      className={
        `step-card kind-${step.kind ?? 'interaction'}` +
        `${isDragging ? ' dragging' : ''}${step.includeInDocs ? '' : ' excluded'}` +
        `${selected ? ' selected' : ''}${nested ? ' nested' : ''}${inGroup ? ' in-group' : ''}`
      }
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // Tocar una tarjeta la convierte en el punto de trabajo: lo siguiente que se
      // pegue o se añada irá justo detrás de ella, no al final de la lista.
      onPointerDownCapture={() => setActiveStep(step.id)}
      onFocusCapture={() => setActiveStep(step.id)}
    >
      <div className="step-head">
        <input
          type="checkbox"
          className="step-select"
          checked={selected}
          title="Marcar para agrupar con otros pasos"
          aria-label={`Marcar el paso ${label}`}
          onChange={() => toggleSelect(step.id)}
        />
        <button
          className="drag-handle"
          title="Arrastrar para reordenar"
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <span className="step-badge">{label}</span>
        <span className="action-chip">{ACTION_LABEL[step.action] ?? step.action}</span>
        <button
          className="icon-btn ai-btn"
          disabled={aiBusy}
          title="Redactar el título y la descripción de este paso con IA"
          aria-label={`Redactar el paso ${label} con IA`}
          onClick={() => void draft([step.id])}
        >
          {aiBusy ? '⋯' : '✨'}
        </button>
        {/* Recortar o señalar sobre la imagen que ya trae el paso. Solo en los
            pasos cuya imagen es del usuario: la de un paso grabado la produce el
            motor y la rehace el runner. */}
        {(isImage || isCapture) && step.tempFile && (
          <button
            className="icon-btn"
            title="Recortar la imagen o señalar algo en ella"
            aria-label={`Ajustar la imagen del paso ${label}`}
            onClick={() => onAdjustImage(step)}
          >
            ✂
          </button>
        )}
        {!isContent && (
          <button
            className={`icon-btn content-btn${step.content?.trim() ? ' has-content' : ''}`}
            title="Añadir una tabla, un bloque de código u otro contenido de Docusaurus"
            aria-label={`Bloque de contenido del paso ${label}`}
            aria-pressed={contentOpen}
            onClick={() => setContentOpen((v) => !v)}
          >
            ▦
          </button>
        )}
        <button
          className={`icon-btn note-btn${step.note?.body.trim() ? ' has-note' : ''}`}
          title="Añadir una nota destacada (admonition de Docusaurus)"
          aria-label={`Nota del paso ${label}`}
          aria-pressed={noteOpen}
          onClick={() => setNoteOpen((v) => !v)}
        >
          📝
        </button>
        {inGroup && (
          <button
            className="icon-btn"
            title="Sacar esta captura de la carpeta (vuelve a ser un paso suelto)"
            aria-label={`Sacar el paso ${label} de la carpeta`}
            onClick={() => removeFromGroup(step.id)}
          >
            ⤴
          </button>
        )}
        {step.groupSources?.length ? (
          <button
            className="icon-btn"
            title="Deshacer la agrupación y devolver cada paso a su sitio"
            aria-label={`Deshacer la agrupación del paso ${label}`}
            onClick={() => ungroupStep(step.id)}
          >
            ⊟
          </button>
        ) : null}
        <button
          className="icon-btn danger"
          title="Eliminar paso"
          onClick={() => removeStep(step.id)}
        >
          ✕
        </button>
      </div>

      <div className="step-body">
        {!isContent &&
          (step.tempFile ? (
            <button
              className="thumb"
              title="Ver la captura a tamaño real"
              onClick={() => onOpenShot(step)}
            >
              <img src={shotUrl(step.tempFile)} alt={`Captura del paso ${label}`} />
            </button>
          ) : (
            <span className="thumb empty">sin captura</span>
          ))}

        <div className="step-fields">
          <input
            ref={titleRef}
            className="step-title"
            value={step.title}
            placeholder={isContent ? 'Título del bloque (opcional)' : 'Título del paso'}
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

      {step.fields?.length ? (
        <div className="step-value">
          <ul className="field-list">
            {step.fields.map((f, i) => (
              <li key={i}>
                <span className="field-label">{f.label}:</span> <code>{f.value || '—'}</code>
                {/* Con un solo elemento no se ofrece quitarlo: vaciar el grupo
                    dejaría un paso que no documenta nada, y para eso está el
                    botón de eliminar el paso entero. */}
                {step.fields && step.fields.length > 1 && (
                  <button
                    className="field-remove"
                    title={`Quitar «${f.label}» de este paso`}
                    aria-label={`Quitar el elemento ${f.label}`}
                    onClick={() => recaptureGroup(removeGroupField(step.id, f.label))}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        step.value !== undefined && (
          <div className="step-value">
            valor: <code>{step.value}</code>
          </div>
        )
      )}

      {contentOpen && (
        <div className="step-content">
          <ContentEditor
            value={step.content ?? ''}
            onChange={setContent}
            onExpand={() => setWideContentId(step.id)}
            // En un paso que ES el bloque, quitarlo sería eliminar el paso: para
            // eso está su ✕, y ofrecer las dos cosas solo confundiría.
            onRemove={
              isContent
                ? undefined
                : () => {
                    updateStep(step.id, { content: '' })
                    setContentOpen(false)
                  }
            }
          />
        </div>
      )}

      {noteOpen && (
        <div className="step-note">
          <NoteEditor
            value={step.note}
            onChange={(note) => updateStep(step.id, { note })}
            onRemove={() => {
              updateStep(step.id, { note: undefined })
              setNoteOpen(false)
            }}
          />
        </div>
      )}

      <div className="step-foot">
        {isManual ? (
          <span className="selector-chip manual">
            {isCapture
              ? 'captura ajena al visor'
              : isImage
                ? 'imagen pegada'
                : 'bloque de contenido'}
          </span>
        ) : preferred ? (
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
