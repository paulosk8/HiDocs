import type { AiDraftRequest, AiStepInput } from '../../shared/ipc-contract'
import type { AiStepDraft } from '../../shared/types'

/**
 * Todo lo que no depende del proveedor: qué se le pide al modelo, cómo se le
 * describe cada paso y cómo se interpreta su respuesta. Claude y Gemini reciben
 * exactamente el mismo texto, así que cambiar de proveedor no cambia el estilo
 * de la documentación.
 */

/**
 * Trozo de la petición, en un formato neutro. Cada proveedor lo traduce a su
 * propia forma (bloques de contenido en Claude, `parts` en Gemini).
 */
export type PromptPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; base64: string; mediaType: string }

export const SYSTEM_PROMPT = `Eres redactor técnico de manuales de usuario. Documentas, paso a paso, cómo se
usa un sistema web interno. Otra persona ha grabado su propia interacción con el
sistema y tú titulas y describes cada paso que registró.

Reglas de redacción:
- Escribe en español, dirigiéndote a quien sigue el manual («Pulsa…», «Escribe…»).
- Título: una sola frase, breve (máximo 70 caracteres), sin punto final, que
  empiece por un verbo en imperativo y nombre el elemento real de la pantalla.
- Descripción: una o dos frases (máximo 300 caracteres) que expliquen qué
  consigue el paso y qué conviene tener en cuenta al hacerlo. No repitas el
  título con otras palabras ni describas lo evidente de la captura.
- Usa únicamente lo que veas en la captura y en los datos del paso. No inventes
  menús, campos, permisos, validaciones ni resultados que no consten.
- Los valores son datos de prueba de la grabación: menciónalos solo si aclaran
  algo. Nunca reproduzcas contraseñas ni valores enmascarados con asteriscos.
- No numeres los títulos: el manual ya numera los pasos.

Devuelve un objeto por cada paso que se te pida, con el mismo \`id\` que recibió.`

const ACTION_LABEL: Record<string, string> = {
  click: 'clic en un elemento',
  fill: 'escribir en un campo',
  select: 'elegir una opción de una lista',
  submit: 'enviar un formulario',
  press: 'pulsar una tecla',
  navigate: 'navegar a otra pantalla'
}

/** Cabecera con el contexto del manual y el índice completo del flujo. */
export function contextText(request: AiDraftRequest): string {
  const { meta, outline } = request
  const lines = [
    'Contexto del manual que se está escribiendo:',
    `- Módulo: ${meta.module || '(sin indicar)'}`,
    `- Funcionalidad: ${meta.feature || '(sin indicar)'}`,
    `- Título del flujo: ${meta.title || '(sin indicar)'}`,
    `- Rol de quien lo ejecuta: ${meta.role || '(sin indicar)'}`,
    `- Sistema: ${meta.baseUrl || '(sin indicar)'}`,
    '',
    'Flujo completo grabado (para que sitúes cada paso; solo redactas los que se',
    'te piden más abajo):'
  ]
  for (const item of outline) {
    lines.push(`  ${item.order}. ${item.title || '(sin título)'}`)
  }
  return lines.join('\n')
}

/** Descripción textual de un paso concreto. */
export function stepText(step: AiStepInput): string {
  const lines = [
    '',
    `--- Paso ${step.order} (id: ${step.id}) ---`,
    `Acción registrada: ${ACTION_LABEL[step.action] ?? step.action}`,
    `Título automático actual: ${step.title || '(vacío)'}`
  ]
  if (step.description.trim()) {
    lines.push(`Descripción actual (mejórala, no la ignores): ${step.description.trim()}`)
  }
  if (step.fields?.length) {
    lines.push('Campos rellenados en este paso:')
    for (const field of step.fields) {
      lines.push(`  · ${field.label}${field.value ? `: ${field.value}` : ' (solo enfocado)'}`)
    }
  } else if (step.value !== undefined) {
    lines.push(`Valor introducido: ${step.value || '(vacío)'}`)
  }
  lines.push(`URL en ese momento: ${step.url}`)
  if (step.screenshot) lines.push('A continuación, la captura de la pantalla en ese momento.')
  return lines.join('\n')
}

/**
 * Esquema JSON de la respuesta. Claude lo usa tal cual (structured outputs);
 * Gemini usa su equivalente en `gemini.ts`, con el mismo contenido.
 */
export const DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description: 'Un elemento por cada paso pedido, en el mismo orden.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'El id del paso, copiado literalmente.' },
          title: { type: 'string', description: 'Título en imperativo, sin punto final.' },
          description: { type: 'string', description: 'Una o dos frases.' }
        },
        required: ['id', 'title', 'description'],
        additionalProperties: false
      }
    }
  },
  required: ['steps'],
  additionalProperties: false
} as const

/** Recorta espacios sobrantes y el punto final que se cuela en los títulos. */
function cleanTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/\.$/, '').slice(0, 200)
}

function cleanDescription(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 600)
}

/**
 * Interpreta la respuesta del modelo. Solo se aceptan los `id` que se pidieron:
 * un modelo que se invente un paso no debe poder sobrescribir otro ni añadir
 * uno que el usuario nunca grabó.
 */
export function parseDrafts(raw: string, allowedIds: string[]): AiStepDraft[] {
  const allowed = new Set(allowedIds)
  // La salida estructurada ya viene en JSON puro, pero un modelo puede envolverla
  // en un bloque de código; quitarlo sale gratis y evita un fallo tonto.
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')
  const parsed: unknown = JSON.parse(text)
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { steps?: unknown })?.steps ?? [])
  if (!Array.isArray(list)) return []

  const seen = new Set<string>()
  const drafts: AiStepDraft[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { id, title, description } = item as Record<string, unknown>
    if (typeof id !== 'string' || !allowed.has(id) || seen.has(id)) continue
    const cleanedTitle = typeof title === 'string' ? cleanTitle(title) : ''
    const cleanedDescription = typeof description === 'string' ? cleanDescription(description) : ''
    // Una propuesta sin título no aporta nada y borraría el que generó el motor.
    if (!cleanedTitle) continue
    seen.add(id)
    drafts.push({ id, title: cleanedTitle, description: cleanedDescription })
  }
  return drafts
}
