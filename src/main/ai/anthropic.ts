import Anthropic from '@anthropic-ai/sdk'
import { DRAFT_JSON_SCHEMA, SYSTEM_PROMPT, type PromptPart } from './prompt'

/**
 * Llamada a la API de Claude. Devuelve el texto JSON de la respuesta; quien
 * llama lo interpreta con `parseDrafts`.
 *
 * Se usa salida estructurada (`output_config.format`) para que la respuesta
 * cumpla el esquema sin tener que reparar JSON a mano, y esfuerzo bajo: redactar
 * dos frases por paso no necesita razonamiento profundo, y la GUI espera.
 */
export async function draftWithClaude(
  apiKey: string,
  model: string,
  parts: PromptPart[]
): Promise<string> {
  const client = new Anthropic({ apiKey })

  const content = parts.map((part) =>
    part.kind === 'text'
      ? ({ type: 'text', text: part.text } as const)
      : ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mediaType as 'image/png',
            data: part.base64
          }
        } as const)
  )

  const message = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: DRAFT_JSON_SCHEMA }
    },
    messages: [{ role: 'user', content }]
  })

  if (message.stop_reason === 'refusal') {
    throw new Error('El modelo rechazó la petición por sus filtros de seguridad.')
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('La respuesta se cortó por longitud; prueba con menos pasos a la vez.')
  }

  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
