import { useRef } from 'react'
import type { AdmonitionType, StepNote } from '../../../shared/types'

/**
 * Editor de la nota destacada de un paso. Reproduce, de forma visual, los
 * «Markdown Features» que Docusaurus publica en un admonition: se elige el tipo
 * (icono + color), se escribe el cuerpo con una barra que inserta el formato
 * sobre la selección (negrita, cursiva, resaltado, código, enlace, lista, emoji)
 * y una vista previa en vivo muestra el resultado tal como se verá en Docusaurus.
 *
 * No arranca Docusaurus ni añade dependencias: el cuerpo se guarda como
 * Markdown/MDX (lo que consume `mdx.ts`) y la vista previa lo renderiza con un
 * mini-render local acotado al subconjunto que ofrece la barra.
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

/** Escapa HTML antes de reintroducir solo las etiquetas seguras de la vista previa. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Markdown en línea → HTML seguro para la vista previa. Solo el subconjunto que
 * inserta la barra: negrita, cursiva, resaltado, código, enlaces y emojis.
 */
function renderInline(text: string): string {
  let html = escapeHtml(text)
  // El resaltado es la única etiqueta MDX que se admite tal cual: se reintroduce
  // tras el escape para que <mark> se pinte pero cualquier otro < siga inerte.
  html = html.replace(/&lt;mark&gt;([\s\S]*?)&lt;\/mark&gt;/g, '<mark>$1</mark>')
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  html = html.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  )
  return html
}

/** Cuerpo Markdown → HTML por bloques (párrafos y listas con «- »). */
function renderBody(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let list: string[] = []
  const flush = (): void => {
    if (list.length) {
      out.push(`<ul>${list.map((li) => `<li>${renderInline(li)}</li>`).join('')}</ul>`)
      list = []
    }
  }
  for (const line of lines) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item) {
      list.push(item[1])
    } else if (line.trim()) {
      flush()
      out.push(`<p>${renderInline(line)}</p>`)
    } else {
      flush()
    }
  }
  flush()
  return out.join('')
}

interface Props {
  value: StepNote | undefined
  onChange: (note: StepNote | undefined) => void
}

const EMPTY: StepNote = { type: 'note', title: '', body: '' }

export function NoteEditor({ value, onChange }: Props): React.JSX.Element {
  const note = value ?? EMPTY
  const bodyRef = useRef<HTMLTextAreaElement>(null)

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
  const previewHtml = renderBody(note.body || '_Escribe el contenido de la nota…_')
  // Aviso honesto: un <mark> sin su cierre no se resalta (se publica literal), así
  // que la vista previa y el manual coinciden pero conviene advertirlo.
  const openMarks = (note.body.match(/<mark>/g) ?? []).length
  const closeMarks = (note.body.match(/<\/mark>/g) ?? []).length
  const unbalancedMark = openMarks !== closeMarks

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

      {unbalancedMark && (
        <p className="note-warn">
          Hay un resaltado <code>&lt;mark&gt;</code> sin cerrar: se publicará como texto normal.
        </p>
      )}

      <div className="note-preview-label">Vista previa</div>
      <div className={`note-preview admonition admonition-${note.type}`}>
        <div className="admonition-heading">
          <span aria-hidden>{meta.icon}</span> {note.title?.trim() || meta.defaultTitle}
        </div>
        <div
          className="admonition-content"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </div>
    </div>
  )
}
