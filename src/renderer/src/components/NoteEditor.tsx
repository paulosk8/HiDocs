import { useRef, useState } from 'react'
import { analyzeContent } from '../../../shared/mdx-content'
import { renderMarkdown } from '../markdown'
import type { AdmonitionType, StepNote } from '../../../shared/types'

/**
 * Editor de la nota destacada de un paso. Reproduce, de forma visual, los
 * «Markdown Features» que Docusaurus publica en un admonition: se elige el tipo
 * (icono + color), se escribe el cuerpo con una barra que inserta el formato
 * sobre la selección (negrita, cursiva, resaltado, código, enlace, lista, emoji)
 * y una vista previa en vivo muestra el resultado tal como se verá en Docusaurus.
 *
 * No arranca Docusaurus ni añade dependencias: el cuerpo se guarda como
 * Markdown/MDX (lo que consume `mdx.ts`) y la vista previa lo renderiza con el
 * mismo motor que los bloques de contenido, sobre el mismo texto saneado que se
 * publica. Dentro de un admonition cabe todo el Markdown, así que la nota admite
 * también listas, tablas o código si hacen falta.
 */

interface AdmonitionMeta {
  label: string
  icon: string
  defaultTitle: string
}

const ADMONITIONS: Record<AdmonitionType, AdmonitionMeta> = {
  note: { label: 'Nota', icon: '📝', defaultTitle: 'Nota' },
  tip: { label: 'Consejo', icon: '💡', defaultTitle: 'Consejo' },
  info: { label: 'Info', icon: 'ℹ️', defaultTitle: 'Información' },
  warning: { label: 'Aviso', icon: '⚠️', defaultTitle: 'Aviso' },
  danger: { label: 'Peligro', icon: '🚫', defaultTitle: 'Peligro' }
}

const EMOJIS = ['✅', '⚠️', '❗', '👉', '🔑', '📌', '🔒', '⏱️', '🧾', '💾']

interface Props {
  value: StepNote | undefined
  onChange: (note: StepNote | undefined) => void
  /**
   * Quita la nota del paso (no solo cierra el editor). 📝 solo abre y cierra, así
   * que sin esto una nota ya escrita se seguía publicando y la única forma de
   * deshacerse de ella era vaciar el cuerpo y el título a mano.
   */
  onRemove?: () => void
}

const EMPTY: StepNote = { type: 'note', title: '', body: '' }

export function NoteEditor({ value, onChange, onRemove }: Props): React.JSX.Element {
  const note = value ?? EMPTY
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  // En línea y no en un diálogo: el visor nativo tapa cualquier superposición
  // que no lance el panel (ver `ContentEditor`).
  const [confirmRemove, setConfirmRemove] = useState(false)

  const setNote = (patch: Partial<StepNote>): void => {
    const next = { ...note, ...patch }
    // Solo se descarta la nota si está en su estado por defecto (tipo «note», sin
    // título ni cuerpo): así elegir el tipo ANTES de escribir no la borra. Un
    // cuerpo vacío no llega a publicarse igualmente (lo filtran storage y mdx).
    const isDefault = next.type === 'note' && !next.title?.trim() && !next.body.trim()
    onChange(isDefault ? undefined : next)
  }

  /** Envuelve la selección del textarea con `before`/`after` (o inserta si no hay). */
  const wrap = (before: string, after: string, placeholder: string): void => {
    const el = bodyRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const selected = note.body.slice(start, end) || placeholder
    const next = note.body.slice(0, start) + before + selected + after + note.body.slice(end)
    setNote({ body: next })
    // Reposiciona el cursor tras el render, seleccionando el texto envuelto.
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = start + before.length
      el.selectionEnd = start + before.length + selected.length
    })
  }

  /** Inserta texto suelto (emoji) en el cursor. */
  const insert = (text: string): void => {
    const el = bodyRef.current
    if (!el) {
      setNote({ body: note.body + text })
      return
    }
    const start = el.selectionStart
    const next = note.body.slice(0, start) + text + note.body.slice(el.selectionEnd)
    setNote({ body: next })
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = el.selectionEnd = start + text.length
    })
  }

  const meta = ADMONITIONS[note.type]
  const previewHtml = renderMarkdown(note.body || '_Escribe el contenido de la nota…_')
  // Aviso honesto: una etiqueta sin cerrar (o no permitida) se publica literal.
  // La vista previa y el manual coinciden, pero conviene advertirlo.
  const issues = analyzeContent(note.body).issues

  return (
    <div className="note-editor">
      <div className="note-types" role="group" aria-label="Tipo de nota">
        {(Object.keys(ADMONITIONS) as AdmonitionType[]).map((t) => (
          <button
            key={t}
            className={`note-type note-type-${t}${note.type === t ? ' active' : ''}`}
            title={`Recuadro «${ADMONITIONS[t].label}»`}
            onClick={() => setNote({ type: t })}
          >
            <span aria-hidden>{ADMONITIONS[t].icon}</span> {ADMONITIONS[t].label}
          </button>
        ))}
        {onRemove &&
          (confirmRemove ? (
            <span className="editor-remove-confirm">
              ¿Quitar la nota?
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setConfirmRemove(false)
                  onRemove()
                }}
              >
                Quitar
              </button>
              <button type="button" onClick={() => setConfirmRemove(false)}>
                Cancelar
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="editor-remove"
              title="Quitar la nota de este paso"
              aria-label="Quitar la nota"
              // Una nota vacía no se ha llegado a escribir: no hay nada que
              // confirmar.
              onClick={() =>
                note.body.trim() || note.title?.trim() ? setConfirmRemove(true) : onRemove()
              }
            >
              🗑
            </button>
          ))}
      </div>

      <input
        className="note-title"
        value={note.title ?? ''}
        placeholder={`Título (por defecto «${meta.defaultTitle}»)`}
        onChange={(e) => setNote({ title: e.target.value })}
      />

      <div className="note-toolbar" role="toolbar" aria-label="Formato">
        <button title="Negrita" onClick={() => wrap('**', '**', 'texto')}>
          <b>B</b>
        </button>
        <button title="Cursiva" onClick={() => wrap('_', '_', 'texto')}>
          <i>I</i>
        </button>
        <button title="Resaltar" onClick={() => wrap('<mark>', '</mark>', 'texto')}>
          <mark>H</mark>
        </button>
        <button title="Código" onClick={() => wrap('`', '`', 'código')}>
          <code>{'</>'}</code>
        </button>
        <button title="Enlace" onClick={() => wrap('[', '](https://)', 'texto')}>
          🔗
        </button>
        <button title="Elemento de lista" onClick={() => wrap('\n- ', '', 'elemento')}>
          ☰
        </button>
        <span className="note-emojis">
          {EMOJIS.map((e) => (
            <button key={e} title={`Insertar ${e}`} onClick={() => insert(e)}>
              {e}
            </button>
          ))}
        </span>
      </div>

      <textarea
        ref={bodyRef}
        className="note-body"
        rows={3}
        value={note.body}
        placeholder="Escribe la nota. Usa la barra para dar formato como en Docusaurus."
        onChange={(e) => setNote({ body: e.target.value })}
      />

      {issues.map((issue, i) => (
        <p key={i} className="note-warn">
          {issue.message}
        </p>
      ))}

      <div className="note-preview-label">Vista previa</div>
      <div className={`note-preview admonition admonition-${note.type}`}>
        <div className="admonition-heading">
          <span aria-hidden>{meta.icon}</span> {note.title?.trim() || meta.defaultTitle}
        </div>
        <div
          className="admonition-content markdown"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </div>
    </div>
  )
}
