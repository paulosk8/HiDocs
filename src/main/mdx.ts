import type { DocSession } from '../shared/types'
import { titleCase } from '../shared/naming'
export { titleCase }

/**
 * Genera la página del manual en formato Docusaurus (MDX) a partir de la sesión.
 *
 * Docusaurus renderiza `.md`/`.mdx`, no los JSON que produce el grabador. Este
 * módulo es el puente: convierte los pasos en una página legible —encabezados
 * numerados (que alimentan el índice lateral de Docusaurus) y su captura— y una
 * categoría por módulo para agrupar en la barra lateral.
 *
 * Estructura resultante bajo la carpeta de salida (que debería ser la carpeta
 * `docs/` del proyecto Docusaurus, o una subcarpeta suya):
 *
 *   <docs>/<módulo>/_category_.json      etiqueta de la barra lateral
 *   <docs>/<módulo>/<funcionalidad>/index.mdx   la página del manual
 *   <docs>/<módulo>/<funcionalidad>/img/…       las capturas
 */

/**
 * Escapa lo que rompería la compilación MDX. Docusaurus v3 compila `.md` y
 * `.mdx` con MDX, así que `<` se interpreta como JSX y `{` como expresión: en
 * texto libre del usuario harían fallar el build entero. Los cierres se escapan
 * también para que no queden sueltos.
 */
function mdxSafe(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
}

/** Valor seguro para un escalar YAML entre comillas dobles (frontmatter). */
function yamlString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const ACTION_LABEL: Record<string, string> = {
  click: 'Clic',
  fill: 'Rellenar el campo',
  select: 'Seleccionar una opción',
  submit: 'Enviar el formulario',
  press: 'Pulsar una tecla',
  navigate: 'Navegar'
}

/**
 * Cuerpo de una nota destacada. La nota es texto enriquecido —su gracia es
 * publicar el diseño de Docusaurus (negrita, `<mark>`, emojis…)—, así que el
 * Markdown se deja pasar para que Docusaurus lo renderice. Pero el build no puede
 * romperse por descuido: un `<` suelto (p. ej. «saldo < 0») MDX lo tomaría por
 * una etiqueta JSX y abortaría el build entero del mantenedor (§10).
 *
 * Por eso se escapa TODO `<`/`>` (y las llaves `{`/`}`) y luego se restauran solo
 * los pares BALANCEADOS de `<mark>…</mark>` que inserta la barra de herramientas.
 * Un `<mark>` sin cerrar, o cualquier otra etiqueta, quedan escapados y visibles,
 * nunca activos. Es exactamente lo que hace la vista previa del editor, para que
 * lo que se ve al redactar y lo que se publica coincidan.
 */
function mdxNoteBody(text: string): string {
  const escaped = text
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(/&lt;mark&gt;([\s\S]*?)&lt;\/mark&gt;/g, '<mark>$1</mark>')
}

const ADMONITION_TYPES = new Set(['note', 'tip', 'info', 'warning', 'danger'])

/**
 * Bloque «admonition» de Docusaurus para la nota de un paso. Devuelve las líneas
 * (con sus separaciones en blanco, que MDX exige alrededor del bloque) o `[]` si
 * la nota no tiene cuerpo.
 */
export function renderNote(note: DocSession['steps'][number]['note']): string[] {
  if (!note || !note.body.trim()) return []
  const type = ADMONITION_TYPES.has(note.type) ? note.type : 'note'
  const title = note.title?.trim() ? `[${mdxSafe(note.title.trim())}]` : ''
  return [`:::${type}${title}`, '', mdxNoteBody(note.body.trim()), '', ':::', '']
}

/** Etiqueta de la categoría de módulo en la barra lateral de Docusaurus. */
export function categoryJson(label: string): string {
  return `${JSON.stringify({ label, collapsible: true, collapsed: false }, null, 2)}\n`
}

/**
 * Página MDX del manual.
 *
 * @param hasImage decide si se referencia la captura de un paso: una imagen que
 *   no se llegó a escribir dejaría un enlace roto y Docusaurus abortaría el build.
 */
export function renderFeatureMdx(
  session: DocSession,
  moduleLabel: string,
  hasImage: (relativePath: string) => boolean,
  subLabel = ''
): string {
  // Los pasos marcados como «no incluir en docs» son de navegación: se omiten
  // del manual pero la numeración visible sigue siendo correlativa.
  const included = session.steps.filter((s) => s.includeInDocs !== false)
  const out: string[] = []

  const title = session.title.trim() || titleCase(session.feature)
  out.push('---')
  out.push(`title: ${yamlString(title)}`)
  out.push(`sidebar_label: ${yamlString(title)}`)
  out.push(
    `description: ${yamlString(
      `Guía paso a paso · ${moduleLabel}${subLabel ? ` · ${subLabel}` : ''}${
        session.role ? ` · Rol: ${session.role}` : ''
      }`
    )}`
  )
  out.push('---')
  out.push('')
  out.push(`# ${mdxSafe(title)}`)
  out.push('')

  const meta: string[] = []
  if (moduleLabel) meta.push(`**Módulo:** ${mdxSafe(moduleLabel)}`)
  if (subLabel) meta.push(`**Subcategoría:** ${mdxSafe(subLabel)}`)
  if (session.role) meta.push(`**Rol:** ${mdxSafe(session.role)}`)
  if (meta.length) {
    out.push(meta.join(' · '))
    out.push('')
  }

  if (!included.length) {
    out.push('_Esta guía todavía no tiene pasos incluidos en la documentación._')
    out.push('')
    return out.join('\n')
  }

  let n = 0
  for (const step of included) {
    n++
    const heading = step.title.trim() || ACTION_LABEL[step.action] || 'Paso'
    out.push(`## ${n}. ${mdxSafe(heading)}`)
    out.push('')
    if (step.description.trim()) {
      out.push(mdxSafe(step.description.trim()))
      out.push('')
    }
    // Campos de un formulario agrupado: una lista de etiqueta → valor. Si el
    // campo solo se enfocó (sin valor), se lista sin «: valor».
    if (step.fields?.length) {
      for (const f of step.fields) {
        out.push(
          f.value ? `- **${mdxSafe(f.label)}:** ${mdxSafe(f.value)}` : `- **${mdxSafe(f.label)}**`
        )
      }
      out.push('')
    }
    // Nota destacada del paso: se publica tal cual como admonition de Docusaurus,
    // entre la descripción y la captura.
    out.push(...renderNote(step.note))
    if (step.screenshot && hasImage(step.screenshot)) {
      out.push(`![Paso ${n}: ${mdxSafe(heading)}](./${step.screenshot})`)
      out.push('')
    }
  }

  return out.join('\n')
}
