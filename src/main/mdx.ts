import type { DocSession, DocStep } from '../shared/types'
import { titleCase } from '../shared/naming'
import { contentImports, sanitizeContent } from '../shared/mdx-content'
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
  navigate: 'Navegar',
  capture: 'Captura',
  image: 'Imagen',
  content: 'Contenido',
  section: 'Sección',
  group: 'Capturas'
}

/**
 * Bloque de contenido del paso (tabla, código, pestañas…). El cuerpo lo escribe
 * el usuario en Markdown/MDX y se publica tal cual, pasado por el mismo
 * saneado que muestra la vista previa del editor: el Markdown funciona, el
 * código se respeta y lo que rompería el build queda escapado y visible (§10).
 */
export function renderContent(content: string | undefined): string[] {
  if (!content || !content.trim()) return []
  return [sanitizeContent(content.trim()), '']
}

const ADMONITION_TYPES = new Set(['note', 'tip', 'info', 'warning', 'danger'])

/**
 * Bloque «admonition» de Docusaurus para la nota de un paso. Devuelve las líneas
 * (con sus separaciones en blanco, que MDX exige alrededor del bloque) o `[]` si
 * la nota no tiene cuerpo.
 */
export function renderNote(note: DocStep['note']): string[] {
  if (!note || !note.body.trim()) return []
  const type = ADMONITION_TYPES.has(note.type) ? note.type : 'note'
  const title = note.title?.trim() ? `[${mdxSafe(note.title.trim())}]` : ''
  // El cuerpo pasa por el mismo saneado que un bloque de contenido: dentro de un
  // admonition cabe todo el Markdown de Docusaurus (listas, tablas, código), y
  // la regla de qué se publica activo debe ser una sola en toda la app.
  return [`:::${type}${title}`, '', sanitizeContent(note.body.trim()), '', ':::', '']
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
  // Las carpetas de capturas (§17) y lo que contiene cada una. Un paso metido en
  // una carpeta no se publica por su cuenta: es una de las ilustraciones del
  // paso que ES la carpeta, y se imprime dentro de ella. Si la carpeta se excluye
  // del manual, se van con ella: sacarlas sueltas convertiría un paso en cuatro.
  const folders = new Map(session.steps.filter((s) => s.kind === 'group').map((s) => [s.id, s]))
  const owner = (step: DocStep): DocStep | undefined =>
    step.groupId ? folders.get(step.groupId) : undefined

  // Los pasos marcados como «no incluir en docs» son de navegación: se omiten
  // del manual pero la numeración visible sigue siendo correlativa.
  const included = session.steps.filter(
    (s) => s.includeInDocs !== false && owner(s)?.includeInDocs !== false
  )
  const members = new Map<string, DocStep[]>()
  for (const step of included) {
    if (!owner(step)) continue
    const list = members.get(step.groupId as string) ?? []
    list.push(step)
    members.set(step.groupId as string, list)
  }
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

  // Los componentes de Docusaurus que use algún bloque de contenido (`<Tabs>`)
  // necesitan su `import` en la cabecera: se recogen de todos los pasos y se
  // declaran una sola vez, para que el usuario no tenga que saberlo.
  const imports = [...new Set(included.flatMap((s) => contentImports(s.content ?? '')))]
  if (imports.length) {
    out.push(...imports, '')
  }

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

  // Con secciones, la página gana un nivel: los apartados son `##` y los pasos
  // pasan a `###`, para que el índice lateral de Docusaurus muestre el manual
  // por apartados y no como una lista plana de treinta pasos. Sin secciones no
  // se cambia nada: las páginas ya publicadas siguen saliendo igual.
  const hasSections = included.some((s) => s.kind === 'section')
  const stepLevel = hasSections ? '###' : '##'
  const contentLevel = hasSections ? '####' : '###'

  let n = 0
  for (const step of included) {
    // Un separador de sección no es un paso: no se numera ni lleva captura. Su
    // título encabeza el apartado y su descripción, si la tiene, lo presenta.
    if (step.kind === 'section') {
      const label = step.title.trim()
      if (label) {
        out.push(`## ${mdxSafe(label)}`)
        out.push('')
      }
      if (step.description.trim()) {
        out.push(mdxSafe(step.description.trim()))
        out.push('')
      }
      continue
    }
    // Lo que está dentro de una carpeta lo publica la carpeta, más abajo.
    if (owner(step)) continue
    // Una carpeta de capturas es UN paso del manual con varias ilustraciones:
    // se numera y se titula como cualquier otro, y debajo van sus capturas en
    // orden, cada una con su pie (el título de la tarjeta) si lo tiene. Las
    // capturas no se numeran: numerarlas diría que hay que hacer cuatro cosas
    // donde el manual describe una.
    if (step.kind === 'group') {
      n++
      out.push(`${stepLevel} ${n}. ${mdxSafe(step.title.trim() || 'Capturas')}`)
      out.push('')
      if (step.description.trim()) {
        out.push(mdxSafe(step.description.trim()))
        out.push('')
      }
      out.push(...renderContent(step.content))
      out.push(...renderNote(step.note))
      for (const member of members.get(step.id) ?? []) {
        const caption = member.title.trim()
        if (caption) {
          out.push(`**${mdxSafe(caption)}**`)
          out.push('')
        }
        if (member.description.trim()) {
          out.push(mdxSafe(member.description.trim()))
          out.push('')
        }
        out.push(...renderContent(member.content))
        out.push(...renderNote(member.note))
        if (member.screenshot && hasImage(member.screenshot)) {
          out.push(`![${caption ? mdxSafe(caption) : `Paso ${n}`}](./${member.screenshot})`)
          out.push('')
        }
      }
      continue
    }
    // Un bloque de contenido no es un paso que nadie ejecute: es material de
    // apoyo (una tabla de valores admitidos, un fragmento de código…). Por eso
    // no consume número —el manual seguiría numerando «4» algo que no se hace— y
    // se titula con un encabezado menor, subordinado al paso anterior.
    const isContent = step.kind === 'content'
    const heading = step.title.trim() || (isContent ? '' : ACTION_LABEL[step.action] || 'Paso')
    if (isContent) {
      if (heading) {
        out.push(`${contentLevel} ${mdxSafe(heading)}`)
        out.push('')
      }
    } else {
      n++
      out.push(`${stepLevel} ${n}. ${mdxSafe(heading)}`)
      out.push('')
    }
    if (step.description.trim()) {
      out.push(mdxSafe(step.description.trim()))
      out.push('')
    }
    // Lo agrupado en el paso: los campos de un formulario o las acciones que el
    // usuario unió a mano, como lista de etiqueta → valor. Sin valor (un clic,
    // un campo solo enfocado) se lista sin «: valor».
    //
    // Salvo que el título ya los enumere: un grupo de botones o de pestañas se
    // titula «Pulsar «Guardar» y «Cerrar»», y repetirlos debajo en una lista no
    // añade nada. Con valores sí se listan siempre: el valor es la información.
    const listedInTitle =
      !!step.fields?.length &&
      step.fields.every((f) => !f.value && step.title.includes(`«${f.label}»`))
    if (step.fields?.length && !listedInTitle) {
      for (const f of step.fields) {
        out.push(
          f.value ? `- **${mdxSafe(f.label)}:** ${mdxSafe(f.value)}` : `- **${mdxSafe(f.label)}**`
        )
      }
      out.push('')
    }
    // Bloque de contenido y nota destacada, entre la descripción y la captura.
    out.push(...renderContent(step.content))
    out.push(...renderNote(step.note))
    if (step.screenshot && hasImage(step.screenshot)) {
      const alt = isContent ? mdxSafe(heading || title) : `Paso ${n}: ${mdxSafe(heading)}`
      out.push(`![${alt}](./${step.screenshot})`)
      out.push('')
    }
  }

  return out.join('\n')
}
