import { tableCell, toMarkdownTable } from '../../shared/mdx-content'

/**
 * Conversión de HTML pegado a Markdown.
 *
 * Es la vía rápida para documentar una tabla del sistema: se selecciona en la
 * página, se copia y se pega en el bloque de contenido; lo que llega al
 * portapapeles como `text/html` se convierte aquí en una tabla Markdown que
 * Docusaurus renderiza con su propio diseño (y que se puede editar a mano
 * después). Sin esto, pegar una tabla dejaba un amasijo de texto sin columnas.
 *
 * Deliberadamente pequeña: cubre tablas, listas, encabezados, código y el
 * formato en línea. Cualquier otra cosa se degrada a texto, que es lo que ya
 * ocurría antes.
 */

/** Formato en línea de un nodo: negrita, cursiva, código y enlaces. */
function inlineOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const el = node as HTMLElement
  const inner = Array.from(el.childNodes).map(inlineOf).join('')
  switch (el.tagName.toLowerCase()) {
    case 'br':
      return ' '
    case 'b':
    case 'strong':
      return inner.trim() ? `**${inner.trim()}**` : ''
    case 'i':
    case 'em':
      return inner.trim() ? `_${inner.trim()}_` : ''
    case 'del':
    case 's':
      return inner.trim() ? `~~${inner.trim()}~~` : ''
    case 'code':
      return inner.trim() ? `\`${inner.trim()}\`` : ''
    case 'a': {
      const href = el.getAttribute('href') ?? ''
      return href && inner.trim() ? `[${inner.trim()}](${href})` : inner
    }
    case 'img': {
      const src = el.getAttribute('src') ?? ''
      return src ? `![${el.getAttribute('alt') ?? ''}](${src})` : ''
    }
    default:
      return inner
  }
}

/** Texto de una celda, ya en Markdown y sin saltos que rompan la tabla. */
function cellText(cell: Element): string {
  return tableCell(inlineOf(cell))
}

/** Una tabla HTML → tabla Markdown (la primera fila hace de cabecera). */
function tableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.rows).map((row) => Array.from(row.cells).map(cellText))
  if (!rows.length) return ''
  // Sin `<th>` en ninguna parte, la primera fila hace igualmente de cabecera:
  // una tabla Markdown siempre la lleva.
  return toMarkdownTable(rows)
}

/** Bloques de un fragmento HTML, en orden. */
function blocksOf(root: ParentNode): string[] {
  const out: string[] = []

  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) out.push(text)
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()

    if (tag === 'table') {
      const markdown = tableToMarkdown(el as HTMLTableElement)
      if (markdown) out.push(markdown)
      continue
    }
    if (/^h[1-6]$/.test(tag)) {
      const text = inlineOf(el).trim()
      if (text) out.push(`${'#'.repeat(Number(tag[1]))} ${text}`)
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(el.children)
        .filter((li) => li.tagName.toLowerCase() === 'li')
        .map((li, index) => `${tag === 'ol' ? `${index + 1}.` : '-'} ${inlineOf(li).trim()}`)
        .filter((line) => line.length > 2)
      if (items.length) out.push(items.join('\n'))
      continue
    }
    if (tag === 'pre') {
      const code = el.textContent ?? ''
      if (code.trim()) out.push(['```', code.replace(/\n+$/, ''), '```'].join('\n'))
      continue
    }
    if (tag === 'blockquote') {
      const inner = blocksOf(el).join('\n\n')
      if (inner.trim()) out.push(inner.split('\n').map((l) => `> ${l}`).join('\n'))
      continue
    }
    if (tag === 'br' || tag === 'hr') {
      if (tag === 'hr') out.push('---')
      continue
    }
    // Contenedores: se bajan un nivel; los elementos con solo texto son párrafo.
    const hasBlocks = el.querySelector('table, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6, p, div')
    if (hasBlocks) {
      out.push(...blocksOf(el))
      continue
    }
    const text = inlineOf(el).trim()
    if (text) out.push(text)
  }

  return out.filter((block) => block.trim())
}

/**
 * HTML del portapapeles → Markdown, o `null` si no aporta nada mejor que el
 * texto plano (sin tablas, listas ni código no merece la pena tocar el pegado).
 */
export function htmlToMarkdown(html: string): string | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  // Lo que no se documenta nunca: guiones de script y estilos incrustados.
  doc.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove())
  if (!doc.body.querySelector('table, ul, ol, pre, h1, h2, h3, h4, h5, h6')) return null

  const markdown = blocksOf(doc.body).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  return markdown || null
}
