import { useMemo, useRef, useState } from 'react'
import { analyzeContent } from '../../../shared/mdx-content'
import { htmlToMarkdown } from '../html-to-markdown'
import { renderMarkdown } from '../markdown'
import {
  CODE_TEMPLATE,
  DETAILS_TEMPLATE,
  TABLE_TEMPLATE,
  TABS_TEMPLATE
} from '../content-templates'

/**
 * Editor del bloque de contenido de un paso (§10).
 *
 * Es la respuesta a «quiero pasarle el código y que me lo previsualice»: se
 * escribe (o se pega) la sintaxis que entiende Docusaurus —tablas, bloques de
 * código, pestañas, `<details>`, admonitions— y debajo se ve, ya renderizada,
 * exactamente lo que se va a publicar. La vista previa no es una aproximación:
 * aplica el mismo saneado (`sanitizeContent`) que el generador de MDX, así que
 * si aquí una etiqueta sale escapada, en el manual saldrá escapada.
 *
 * Pegar desde el sistema documentado convierte el HTML a Markdown (una tabla
 * copiada de la página aparece ya como tabla), que es el atajo que evita tener
 * que escribir las columnas a mano.
 */

interface Props {
  value: string
  onChange: (value: string) => void
  /** modo ancho (modal): editor y vista previa en paralelo */
  wide?: boolean
  /** abre el editor a pantalla completa; ausente si ya lo está */
  onExpand?: () => void
  /**
   * Quita el bloque del paso (no solo cierra el editor). Ausente cuando el paso
   * ES el bloque: ahí quitarlo sería eliminar el paso, y para eso está su ✕.
   *
   * Existe porque ▦ solo abre y cierra: cerrarlo dejaba el bloque escrito —y
   * publicándose en el manual— sin ninguna forma visible de deshacerse de él que
   * no fuera seleccionar todo el texto y borrarlo a mano.
   */
  onRemove?: () => void
  autoFocus?: boolean
}

export function ContentEditor({
  value,
  onChange,
  wide = false,
  onExpand,
  onRemove,
  autoFocus = false
}: Props): React.JSX.Element {
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  // La confirmación es EN LÍNEA, no un diálogo: el visor nativo se pinta por
  // encima del HTML y una superposición lanzada desde una tarjeta quedaría
  // tapada (el panel solo sabe ocultarlo para sus propios diálogos).
  const [confirmRemove, setConfirmRemove] = useState(false)

  const { issues } = useMemo(() => analyzeContent(value), [value])
  const previewHtml = useMemo(
    () => renderMarkdown(value.trim() || '_El bloque está vacío: escribe o pega su contenido._'),
    [value]
  )

  /** Envuelve la selección (o inserta el marcador si no hay nada seleccionado). */
  const wrap = (before: string, after: string, placeholder: string): void => {
    const el = bodyRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const selected = value.slice(start, end) || placeholder
    onChange(value.slice(0, start) + before + selected + after + value.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.selectionStart = start + before.length
      el.selectionEnd = start + before.length + selected.length
    })
  }

  /** Inserta un bloque entero en su propia línea, separado del texto vecino. */
  const insertBlock = (block: string): void => {
    const el = bodyRef.current
    const at = el ? el.selectionStart : value.length
    const before = value.slice(0, at)
    const after = value.slice(el ? el.selectionEnd : value.length)
    const prefix = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    const suffix = !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
    const next = before + prefix + block + suffix + after
    onChange(next)
    const cursor = (before + prefix + block).length
    requestAnimationFrame(() => {
      el?.focus()
      if (el) el.selectionStart = el.selectionEnd = cursor
    })
  }

  /**
   * Pegar HTML (una tabla copiada del sistema, por ejemplo) inserta su
   * equivalente en Markdown. Si el HTML no aporta estructura, se deja el pegado
   * normal: convertir un párrafo suelto solo añadiría ruido.
   */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const html = event.clipboardData.getData('text/html')
    if (!html) return
    const markdown = htmlToMarkdown(html)
    if (!markdown) return
    event.preventDefault()
    insertBlock(markdown)
  }

  const toolbar = (
    <div className="content-toolbar" role="toolbar" aria-label="Insertar contenido">
      <button type="button" title="Negrita" onClick={() => wrap('**', '**', 'texto')}>
        <b>B</b>
      </button>
      <button type="button" title="Cursiva" onClick={() => wrap('_', '_', 'texto')}>
        <i>I</i>
      </button>
      <button type="button" title="Resaltar" onClick={() => wrap('<mark>', '</mark>', 'texto')}>
        <mark>H</mark>
      </button>
      <button type="button" title="Código en línea" onClick={() => wrap('`', '`', 'código')}>
        <code>{'`'}</code>
      </button>
      <button type="button" title="Tecla" onClick={() => wrap('<kbd>', '</kbd>', 'Ctrl')}>
        ⌨
      </button>
      <span className="toolbar-sep" />
      <button type="button" title="Encabezado" onClick={() => insertBlock('### Título')}>
        H
      </button>
      <button type="button" title="Lista" onClick={() => insertBlock('- Primer elemento')}>
        ☰
      </button>
      <button type="button" title="Cita" onClick={() => insertBlock('> Cita')}>
        ❝
      </button>
      <button type="button" title="Enlace" onClick={() => wrap('[', '](https://)', 'texto')}>
        🔗
      </button>
      <span className="toolbar-sep" />
      <button
        type="button"
        className="labeled"
        title="Insertar una tabla (o pega una copiada del sistema)"
        onClick={() => insertBlock(TABLE_TEMPLATE)}
      >
        ▦ Tabla
      </button>
      <button
        type="button"
        className="labeled"
        title="Insertar un bloque de código con resaltado"
        onClick={() => insertBlock(CODE_TEMPLATE)}
      >
        {'{ } Código'}
      </button>
      <button
        type="button"
        className="labeled"
        title="Pestañas de Docusaurus (los imports se añaden solos al publicar)"
        onClick={() => insertBlock(TABS_TEMPLATE)}
      >
        ⇉ Pestañas
      </button>
      <button
        type="button"
        className="labeled"
        title="Bloque desplegable"
        onClick={() => insertBlock(DETAILS_TEMPLATE)}
      >
        ▸ Detalle
      </button>
      {onExpand && (
        <button
          type="button"
          className="content-expand"
          title="Editar en grande, con la vista previa al lado"
          onClick={onExpand}
        >
          ⤢
        </button>
      )}
      {onRemove &&
        (confirmRemove ? (
          <span className="editor-remove-confirm">
            ¿Quitar el bloque?
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
            title="Quitar el bloque de contenido de este paso"
            aria-label="Quitar el bloque de contenido"
            // Vacío no hay nada que perder, así que no se pregunta: preguntar por
            // todo enseña a decir que sí sin leer.
            onClick={() => (value.trim() ? setConfirmRemove(true) : onRemove())}
          >
            🗑
          </button>
        ))}
    </div>
  )

  const editor = (
    <textarea
      ref={bodyRef}
      className="content-body"
      rows={wide ? 20 : 6}
      value={value}
      autoFocus={autoFocus}
      spellCheck={false}
      placeholder={
        'Escribe o pega aquí el contenido: una tabla Markdown, un bloque de código, pestañas…\n' +
        'Al pegar una tabla copiada del sistema se convierte sola a Markdown.'
      }
      onChange={(e) => onChange(e.target.value)}
      onPaste={onPaste}
    />
  )

  const preview = (
    <>
      <div className="content-preview-label">Vista previa (como se publicará)</div>
      <div className="content-preview markdown" dangerouslySetInnerHTML={{ __html: previewHtml }} />
    </>
  )

  return (
    <div className={`content-editor${wide ? ' wide' : ''}`}>
      {toolbar}
      {issues.map((issue, i) => (
        <p key={i} className="note-warn">
          {issue.message}
        </p>
      ))}
      {wide ? (
        <div className="content-split">
          <div className="content-pane">{editor}</div>
          <div className="content-pane">{preview}</div>
        </div>
      ) : (
        <>
          {editor}
          {preview}
        </>
      )}
    </div>
  )
}
