import { sanitizeContent } from '../../shared/mdx-content'

/**
 * Vista previa de lo que publicará Docusaurus.
 *
 * El editor de bloques promete algo muy concreto: «pega el código y velo». Para
 * que esa promesa sea cierta, la vista previa parte del MISMO texto saneado que
 * se escribe en el `.mdx` (`sanitizeContent`) y lo renderiza con este
 * mini-Markdown: tablas, bloques de código, listas, citas, encabezados,
 * admonitions, pestañas y el HTML permitido. Lo que aquí se ve escapado, allí se
 * publica escapado; lo que aquí se ve activo, allí se publica activo.
 *
 * No es un Markdown completo (ni pretende serlo) ni añade dependencias: cubre lo
 * que ofrece la barra de herramientas y lo que se pega desde un sistema web.
 */

/** Escapa texto que debe verse literal (el contenido de los bloques de código). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Marca interna para apartar el código en línea mientras se aplica el formato.
 * Es un carácter de control: no puede aparecer en lo que escribe el usuario, así
 * que nunca se confunde con su texto.
 */
const MARK = '\u0000'

/**
 * Formato en línea. El texto llega ya saneado, así que las etiquetas permitidas
 * (`<mark>`, `<kbd>`…) pasan tal cual y lo demás ya viene escapado.
 */
function inline(text: string): string {
  // El código en línea se aparta primero: dentro no vale ningún otro formato.
  const spans: string[] = []
  let html = text.replace(/(`+)([\s\S]+?)\1/g, (_m, _ticks: string, code: string) => {
    spans.push(`<code>${escapeHtml(code)}</code>`)
    return `${MARK}${spans.length - 1}${MARK}`
  })

  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" />')
  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  )
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  html = html.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')

  return html.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_m, i: string) => spans[Number(i)])
}

/** Celdas de una fila de tabla Markdown, respetando las barras escapadas. */
function cells(row: string): string[] {
  return row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim())
}

/** Alineación declarada en la fila de guiones de una tabla. */
function alignOf(spec: string): string {
  if (/^:-+:$/.test(spec)) return 'center'
  if (/^-+:$/.test(spec)) return 'right'
  if (/^:-+$/.test(spec)) return 'left'
  return ''
}

const ADMONITION_ICON: Record<string, string> = {
  note: '📝',
  tip: '💡',
  info: 'ℹ️',
  warning: '⚠️',
  danger: '🚫'
}

const ADMONITION_TITLE: Record<string, string> = {
  note: 'Nota',
  tip: 'Consejo',
  info: 'Información',
  warning: 'Aviso',
  danger: 'Peligro'
}

/** Etiquetas de bloque que se dejan pasar en crudo (ya vienen saneadas). */
const RAW_BLOCK =
  /^\s*<\/?(div|p|details|summary|blockquote|figure|figcaption|table|thead|tbody|tfoot|tr|th|td|caption|ul|ol|li|dl|dt|dd|hr|br|img|pre)\b/

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

/**
 * `<Tabs>`/`<TabItem>` se dibujan como un recuadro con sus etiquetas visibles:
 * en Docusaurus son pestañas de verdad; aquí basta con que se entienda qué
 * contiene cada una.
 */
function renderTabsTag(line: string): string | null {
  if (/^\s*<Tabs\b/.test(line)) return '<div class="mdx-tabs">'
  if (/^\s*<\/Tabs>/.test(line)) return '</div>'
  const open = /^\s*<TabItem\b([^>]*)>/.exec(line)
  if (open) {
    const label = /label=(?:"([^"]*)"|'([^']*)')/.exec(open[1])
    const value = /value=(?:"([^"]*)"|'([^']*)')/.exec(open[1])
    const name = label?.[1] ?? label?.[2] ?? value?.[1] ?? value?.[2] ?? 'Pestaña'
    return `<div class="mdx-tab"><div class="mdx-tab-label">${escapeHtml(
      name
    )}</div><div class="mdx-tab-body">`
  }
  if (/^\s*<\/TabItem>/.test(line)) return '</div></div>'
  return null
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-')
}

function renderBlocks(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  let i = 0

  /** ¿La línea `n` abre un bloque propio? (corta el párrafo en curso) */
  const opensBlock = (n: number): boolean => {
    const line = lines[n]
    if (line === undefined) return false
    return (
      FENCE.test(line) ||
      /^\s*:::/.test(line) ||
      /^#{1,6}\s+/.test(line) ||
      /^\s*>\s?/.test(line) ||
      LIST_ITEM.test(line) ||
      /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
      RAW_BLOCK.test(line) ||
      renderTabsTag(line) !== null ||
      (line.includes('|') && isTableSeparator(lines[n + 1] ?? ''))
    )
  }

  while (i < lines.length) {
    const line = lines[i]

    // Bloque de código con valla, opcionalmente con lenguaje y `title="…"`.
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)(.*)$/.exec(line)
    if (fence) {
      const mark = fence[1][0]
      const info = `${fence[2]} ${fence[3]}`
      const lang = fence[2] && !fence[2].includes('=') ? fence[2] : ''
      const title = /title="([^"]*)"/.exec(info)?.[1] ?? ''
      const closer = new RegExp(`^\\s{0,3}\\${mark}{3,}\\s*$`)
      const body: string[] = []
      i++
      while (i < lines.length && !closer.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++
      out.push(
        `<div class="code-block">${
          title ? `<div class="code-title">${escapeHtml(title)}</div>` : ''
        }<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(
          body.join('\n')
        )}</code></pre></div>`
      )
      continue
    }

    // Admonition de Docusaurus: `:::tip[Título]` … `:::`
    const adm = /^\s*:::(\w+)(?:\[(.*)\])?\s*$/.exec(line)
    if (adm && ADMONITION_ICON[adm[1]]) {
      const type = adm[1]
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++
      out.push(
        `<div class="admonition admonition-${type}">` +
          `<div class="admonition-heading"><span aria-hidden="true">${ADMONITION_ICON[type]}</span> ${escapeHtml(
            adm[2]?.trim() || ADMONITION_TITLE[type]
          )}</div>` +
          `<div class="admonition-content">${renderBlocks(body.join('\n'))}</div></div>`
      )
      continue
    }

    // Tabla: la fila de cabecera y, debajo, la de guiones.
    if (line.includes('|') && isTableSeparator(lines[i + 1] ?? '')) {
      const head = cells(line)
      const aligns = cells(lines[i + 1]).map(alignOf)
      i += 2
      const body: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        body.push(cells(lines[i]))
        i++
      }
      const style = (n: number): string =>
        aligns[n] ? ` style="text-align:${aligns[n]}"` : ''
      const th = head.map((c, n) => `<th${style(n)}>${inline(c)}</th>`).join('')
      const rows = body
        .map(
          (row) =>
            `<tr>${head.map((_c, n) => `<td${style(n)}>${inline(row[n] ?? '')}</td>`).join('')}</tr>`
        )
        .join('')
      out.push(
        `<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      // Se rebaja dos niveles: la vista previa vive dentro de una tarjeta, no es
      // el documento entero.
      const level = Math.min(heading[1].length + 2, 6)
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`)
      i++
      continue
    }

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr />')
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${renderBlocks(body.join('\n'))}</blockquote>`)
      continue
    }

    // Listas, con un nivel de anidamiento (lo que ofrece la barra).
    const first = LIST_ITEM.exec(line)
    if (first) {
      const tag = /^[-*+]$/.test(first[2]) ? 'ul' : 'ol'
      const items: Array<{ text: string; children: string[] }> = []
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i])
        if (item && item[1].length < 2) {
          items.push({ text: item[3], children: [] })
          i++
          continue
        }
        // Línea sangrada bajo el último elemento: es contenido suyo.
        if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1].children.push(lines[i].slice(2))
          i++
          continue
        }
        break
      }
      out.push(
        `<${tag}>${items
          .map(
            (it) =>
              `<li>${inline(it.text)}${
                it.children.length ? renderBlocks(it.children.join('\n')) : ''
              }</li>`
          )
          .join('')}</${tag}>`
      )
      continue
    }

    // Pestañas y HTML de bloque permitido: pasan tal cual.
    const tabs = renderTabsTag(line)
    if (tabs !== null) {
      out.push(tabs)
      i++
      continue
    }
    if (RAW_BLOCK.test(line)) {
      out.push(line)
      i++
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    // Párrafo: hasta un salto en blanco o el comienzo de otro bloque.
    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && !(paragraph.length && opensBlock(i))) {
      paragraph.push(lines[i])
      i++
    }
    if (paragraph.length) out.push(`<p>${inline(paragraph.join('\n'))}</p>`)
  }

  return out.join('')
}

/**
 * Cuerpo escrito por el usuario → HTML de la vista previa, pasando por el mismo
 * saneado que el MDX publicado.
 */
export function renderMarkdown(body: string): string {
  return renderBlocks(sanitizeContent(body))
}
