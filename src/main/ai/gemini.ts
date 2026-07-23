import { GoogleGenAI, Type, type Part, type Schema } from '@google/genai'
import { SYSTEM_PROMPT, type PromptPart } from './prompt'

/**
 * Llamada a la API de Gemini. Equivalente punto por punto a `anthropic.ts`: el
 * mismo prompt de sistema, el mismo esquema de respuesta y el mismo contrato de
 * salida (el JSON en texto), para que la redacción no dependa del proveedor.
 *
 * El esquema se declara aquí, y no en `prompt.ts`, porque Gemini usa su propio
 * dialecto (subconjunto de OpenAPI) en vez de JSON Schema.
 */
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    steps: {
      type: Type.ARRAY,
      description: 'Un elemento por cada paso pedido, en el mismo orden.',
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'El id del paso, copiado literalmente.' },
          title: { type: Type.STRING, description: 'Título en imperativo, sin punto final.' },
          description: { type: Type.STRING, description: 'Una o dos frases.' }
        },
        required: ['id', 'title', 'description']
      }
    }
  },
  required: ['steps']
}

export async function draftWithGemini(
  apiKey: string,
  model: string,
  parts: PromptPart[]
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey })

  const contentParts: Part[] = parts.map((part) =>
    part.kind === 'text'
      ? { text: part.text }
      : { inlineData: { mimeType: part.mediaType, data: part.base64 } }
  )

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: contentParts }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA
    }
  })

  const text = response.text
  if (!text) {
    // Sin texto la causa habitual es un bloqueo por filtros: se propaga el
    // motivo que dé la respuesta para que la GUI pueda explicarlo.
    const reason = response.candidates?.[0]?.finishReason
    throw new Error(
      reason && reason !== 'STOP'
        ? `El modelo no devolvió texto (motivo: ${reason}).`
        : 'El modelo no devolvió ninguna respuesta.'
    )
  }
  return text
}
