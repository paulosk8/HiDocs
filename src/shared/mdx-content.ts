/**
 * Bloques de contenido: saneado y análisis del Markdown/MDX que escribe el
 * usuario (§10).
 *
 * Un bloque de contenido es la única parte del manual donde se escribe sintaxis
 * de Docusaurus a mano (tablas, fragmentos de código, pestañas, `<details>`…), y
 * eso choca con dos exigencias que no se pueden negociar:
 *
 * 1. El build del mantenedor NO puede romperse. Docusaurus v3 compila `.mdx` con
 *    MDX, así que un `<` suelto se toma por una etiqueta JSX y `{` por una
 *    expresión: «saldo < 0» abortaría el build entero del sitio.
 * 2. Lo que el usuario ve al escribir tiene que ser lo que se publica. Por eso
 *    este módulo es compartido: la vista previa del editor y el generador de MDX
 *    aplican exactamente las mismas reglas, no dos aproximaciones parecidas.
 *
 * La regla es: se escapa `<` y `{`/`}` en el texto libre, salvo en las etiquetas
 * de la lista blanca que estén BIEN CERRADAS, y salvo dentro del código (vallas
 * ``` y `código en línea`), que MDX ya deja intacto —y donde escapar rompería lo
 * que se muestra, porque Markdown no descodifica entidades dentro de código—.
 *
 * `>` no se escapa: MDX no le da ningún significado y en Markdown abre una cita,
 * que es una de las cosas que el editor ofrece.
 */

/**
 * Etiquetas que se publican tal cual. Son las que Docusaurus renderiza de serie
 * (o admite en MDX) y que el editor ofrece; cualquier otra se publica como texto
 * visible, nunca activa.
 */
const ALLOWED_TAGS = new Set([
  // formato en línea
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'mark',
  'small',
  'sub',
  'sup',
  'kbd',
  'code',
  'abbr',
  'br',
  'hr',
  'span',
  // bloques
  'div',
  'p',
  'blockquote',
  'pre',
  'details',
  'summary',
  'figure',
  'figcaption',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'img',
  'a',
  // componentes de Docusaurus (necesitan import; ver `contentImports`)
  'Tabs',
  'TabItem'
])

/** Etiquetas sin cierre: se aprueban solas, no entran en el balanceo. */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr'])

/** Componentes de Docusaurus que exigen un `import` en la cabecera del MDX. */
const COMPONENT_IMPORTS: Record<string, string> = {
  Tabs: "import Tabs from '@theme/Tabs';",
  TabItem: "import TabItem from '@theme/TabItem';"
}

interface Range {
  start: number
  end: number
}

interface TagToken extends Range {
  name: string
  closing: boolean
  selfClosing: boolean
}

export interface ContentIssue {
  /** `warn`: se publica, pero no como el usuario espera */
  level: 'warn'
  message: string
}

export interface ContentAnalysis {
  /** avisos para mostrar bajo el editor */
  issues: ContentIssue[]
  /** líneas `import` que el MDX necesita por los componentes usados */
  imports: string[]
}

/**
 * Tramos de código (vallas y código en línea), que se copian tal cual. Se
 * calculan sobre el texto original para poder decidir, más adelante, qué
 * etiquetas están dentro de código y no deben tocarse.
 */
function codeRanges(text: string): Range[] {
  const ranges: Range[] = []
  const lines = text.split('\n')
  let offset = 0
  let fenceStart = -1
  let fenceMark = ''

  for (const line of lines) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (fenceStart < 0) {
        fenceStart = offset
        fenceMark = fence[1][0]
      } else if (fence[1][0] === fenceMark) {
        ranges.push({ start: fenceStart, end: offset + line.length })
        fenceStart = -1
      }
    }
    offset += line.length + 1
  }
  // Valla sin cerrar: llega hasta el final (es lo que hará también Markdown).
  if (fenceStart >= 0) ranges.push({ start: fenceStart, end: text.length })

  // Código en línea, solo fuera de las vallas ya localizadas.
  const inline = /(`+)([\s\S]+?)\1/g
  let match: RegExpExecArray | null
  while ((match = inline.exec(text))) {
    const start = match.index
    if (ranges.some((r) => start >= r.start && start < r.end)) continue
    ranges.push({ start, end: start + match[0].length })
  }

  return ranges.sort((a, b) => a.start - b.start)
}

function inside(ranges: Range[], position: number): boolean {
  return ranges.some((r) => position >= r.start && position < r.end)
}

/** Etiquetas del texto, saltando las que caen dentro de código. */
function scanTags(text: string, code: Range[]): TagToken[] {
  const re = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  const tags: TagToken[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    if (inside(code, match.index)) continue
    tags.push({
      start: match.index,
      end: match.index + match[0].length,
      name: match[2],
      closing: match[1] === '/',
      selfClosing: /\/\s*$/.test(match[3])
    })
  }
  return tags
}

interface Approval {
  approved: TagToken[]
  issues: ContentIssue[]
  components: Set<string>
}

/**
 * Decide qué etiquetas se publican activas: las de la lista blanca que estén
 * bien cerradas (o sean vacías/autocerradas). Una etiqueta desconocida o sin
 * cierre queda escapada —visible como texto—, que es preferible a publicar algo
 * que rompa el build o el diseño de la página.
 */
function approveTags(tags: TagToken[]): Approval {
  const approved: TagToken[] = []
  const issues: ContentIssue[] = []
  const components = new Set<string>()
  const unknown = new Set<string>()
  const unclosed = new Set<string>()
  const stack: TagToken[] = []

  for (const tag of tags) {
    if (!ALLOWED_TAGS.has(tag.name)) {
      unknown.add(tag.name)
      continue
    }
    if (COMPONENT_IMPORTS[tag.name]) components.add(tag.name)

    if (VOID_TAGS.has(tag.name.toLowerCase()) || tag.selfClosing) {
      approved.push(tag)
      continue
    }
    if (!tag.closing) {
      stack.push(tag)
      continue
    }
    // Cierre: solo vale si es el que está abierto ahora mismo. Un anidamiento
    // cruzado (<b><i></b></i>) no es HTML válido y JSX lo rechazaría.
    const open = stack[stack.length - 1]
    if (open && open.name === tag.name) {
      stack.pop()
      approved.push(open, tag)
    } else {
      unclosed.add(tag.name)
    }
  }

  for (const open of stack) unclosed.add(open.name)

  if (unknown.size) {
    issues.push({
      level: 'warn',
      message: `Estas etiquetas no están permitidas y se publicarán como texto: ${[...unknown]
        .map((t) => `<${t}>`)
        .join(', ')}.`
    })
  }
  if (unclosed.size) {
    issues.push({
      level: 'warn',
      message: `Estas etiquetas no están bien cerradas y se publicarán como texto: ${[...unclosed]
        .map((t) => `<${t}>`)
        .join(', ')}.`
    })
  }

  return { approved: approved.sort((a, b) => a.start - b.start), issues, components }
}

/** Escapa lo que MDX interpretaría como JSX o como expresión. */
function escapeFragment(text: string): string {
  return text.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/</g, '&lt;')
}

/**
 * Deja el cuerpo listo para publicarse en un `.mdx`: el Markdown pasa entero,
 * el código se respeta, las etiquetas permitidas y bien cerradas se mantienen
 * activas y todo lo demás se escapa.
 */
export function sanitizeContent(body: string): string {
  const code = codeRanges(body)
  const { approved } = approveTags(scanTags(body, code))
  // Los tramos que se copian tal cual: código y etiquetas aprobadas.
  const verbatim = [...code, ...approved].sort((a, b) => a.start - b.start)

  let out = ''
  let cursor = 0
  for (const range of verbatim) {
    if (range.start < cursor) continue
    out += escapeFragment(body.slice(cursor, range.start))
    out += body.slice(range.start, range.end)
    cursor = range.end
  }
  return out + escapeFragment(body.slice(cursor))
}

/** Avisos e `import`s necesarios, para el editor y para el generador de MDX. */
export function analyzeContent(body: string): ContentAnalysis {
  const code = codeRanges(body)
  const { issues, components } = approveTags(scanTags(body, code))
  const all = [...issues]

  const fences = (body.match(/^\s{0,3}(?:`{3,}|~{3,})/gm) ?? []).length
  if (fences % 2 !== 0) {
    all.push({
      level: 'warn',
      message: 'Hay un bloque de código (```) sin cerrar: todo lo que sigue se publicará como código.'
    })
  }

  return {
    issues: all,
    imports: [...components].map((name) => COMPONENT_IMPORTS[name])
  }
}

/** `import`s que el MDX necesita por los componentes usados en el cuerpo. */
export function contentImports(body: string): string[] {
  return analyzeContent(body).imports
}

/* ---------- ayudas de edición (compartidas con la GUI) ---------- */

/** Escapa el contenido de una celda para que no rompa la tabla Markdown. */
export function tableCell(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()
}

/**
 * Tabla Markdown a partir de una matriz de celdas (la primera fila es la
 * cabecera). Es lo que producen tanto el generador de tablas del editor como la
 * conversión de una tabla HTML pegada desde el sistema documentado.
 */
export function toMarkdownTable(rows: string[][], align: Array<'left' | 'center' | 'right'> = []): string {
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (row: string[]): string[] =>
    Array.from({ length: width }, (_, i) => tableCell(row[i] ?? '') || ' ')
  const separator = Array.from({ length: width }, (_, i) => {
    switch (align[i]) {
      case 'center':
        return ':---:'
      case 'right':
        return '---:'
      default:
        return '---'
    }
  })
  const [head, ...body] = rows
  return [
    `| ${pad(head).join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((row) => `| ${pad(row).join(' | ')} |`)
  ].join('\n')
}
