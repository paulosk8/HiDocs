import { readFile } from 'node:fs/promises'
import type { AiDraftRequest, AiStepInput } from '../../shared/ipc-contract'
import { apiKeyProblem, type AiDraftResult, type AiStepDraft } from '../../shared/types'
import { aiSettings, getAiKey } from '../settings'
import { REFERENCE_MARK, contextText, parseDrafts, stepText, type PromptPart } from './prompt'
import { draftWithClaude } from './anthropic'
import { draftWithGemini } from './gemini'

/**
 * Asistencia de IA para redactar los pasos (§11).
 *
 * La llamada vive en el proceso principal, como las de Git: la clave nunca pasa
 * por el renderer y las capturas se leen del disco aquí.
 *
 * Los pasos se redactan por lotes, no de uno en uno: al modelo se le da siempre
 * el índice completo del flujo, así que redactar seis pasos juntos sale más
 * coherente (y más barato, porque el contexto se envía una vez) que seis
 * llamadas sueltas. El lote se mantiene pequeño para que el progreso avance a la
 * vista y para que una petición con seis capturas no se dispare de tamaño.
 */
const CHUNK_SIZE = 6

export type AiProgress = (progress: { done: number; total: number }) => void

/** Traduce los fallos habituales de ambas APIs a algo accionable en la GUI. */
function explain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/\b401\b|invalid x-api-key|API key not valid|API_KEY_INVALID/i.test(message)) {
    return 'La clave no es válida o ha caducado. Revísala en Ajustes de IA.'
  }
  if (/\b429\b|rate.?limit|RESOURCE_EXHAUSTED/i.test(message)) {
    return 'El proveedor está limitando las peticiones. Espera un momento y reinténtalo.'
  }
  if (/\b404\b|not_found_error|NOT_FOUND|is not found for API version/i.test(message)) {
    return 'Ese modelo no está disponible para tu clave. Elige otro en Ajustes de IA.'
  }
  if (/\b(402|403)\b|credit balance|billing|PERMISSION_DENIED/i.test(message)) {
    return `El proveedor rechazó la petición por permisos o saldo: ${message}`
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return 'No se pudo conectar con el proveedor. Comprueba la conexión a internet.'
  }
  // La clave viaja en una cabecera HTTP, que solo admite ASCII: si lleva un
  // acento o un emoji, la petición ni sale y el error que da es ilegible.
  if (/ByteString/i.test(message)) {
    return 'La clave guardada tiene caracteres que una clave no lleva. Vuelve a introducirla en «IA…» de la barra superior.'
  }
  return message
}

/** Lee la captura del paso en base64, o `null` si no se puede (paso sin imagen). */
async function readShot(step: AiStepInput): Promise<PromptPart | null> {
  if (!step.screenshot) return null
  try {
    const data = await readFile(step.screenshot)
    return { kind: 'image', base64: data.toString('base64'), mediaType: 'image/png' }
  } catch {
    // Un paso sin captura legible se redacta igualmente con su texto: es peor
    // abortar el lote entero por una imagen que ya no está.
    return null
  }
}

async function buildParts(
  request: AiDraftRequest,
  chunk: AiStepInput[],
  useScreenshot: boolean
): Promise<PromptPart[]> {
  const parts: PromptPart[] = [{ kind: 'text', text: contextText(request) }]
  for (const step of chunk) {
    const shot = useScreenshot ? await readShot(step) : null
    // Si al final no hay imagen, no se le anuncia una que no va a recibir.
    parts.push({ kind: 'text', text: stepText({ ...step, screenshot: shot ? step.screenshot : undefined }) })
    if (shot) parts.push(shot)
  }
  parts.push({
    kind: 'text',
    text: `\nRedacta ahora el título y la descripción de ${chunk.length === 1 ? 'ese paso' : `esos ${chunk.length} pasos`}.`
  })
  return parts
}

/**
 * Respuesta simulada para las pruebas de humo: la prueba comprueba el circuito
 * completo (ajustes → IPC → aplicar en el panel) sin depender de la red ni de
 * una clave real. Solo se activa con la variable de entorno, y después de
 * comprobar que hay clave, para que el caso «sin clave» también se pruebe.
 *
 * Recibe el prompt ya armado, no solo los pasos: así la prueba ejercita el
 * constructor del prompt de verdad —incluido el material de referencia que se le
 * añade— y no únicamente la llamada. Lo que no se hace es enviarlo.
 */
function fakeDrafts(chunk: AiStepInput[], prompt: string): AiStepDraft[] {
  const withReference = prompt.includes(REFERENCE_MARK)
  return chunk.map((step) => ({
    id: step.id,
    title: `Redactado: ${step.title || step.action}`,
    description:
      `Descripción generada para el paso ${step.order} (${step.action}).` +
      (withReference ? ' Con material de referencia.' : '')
  }))
}

export async function draftSteps(
  request: AiDraftRequest,
  onProgress: AiProgress
): Promise<AiDraftResult> {
  if (!request.steps.length) return { drafts: [] }

  const settings = await aiSettings()
  const apiKey = await getAiKey(settings.provider)
  if (!apiKey) {
    return {
      drafts: [],
      error: 'Falta la clave de la API. Configúrala en «IA…» de la barra superior.'
    }
  }
  // Una clave guardada por una versión que no la comprobaba: se detiene aquí,
  // porque el error del proveedor (o el de la propia cabecera HTTP) no diría que
  // el problema está en la clave.
  if (apiKeyProblem(apiKey)) {
    return {
      drafts: [],
      error:
        'La clave guardada no parece una clave de la API (tiene caracteres o una longitud que una clave no tiene). Vuelve a introducirla en «IA…» de la barra superior.'
    }
  }
  const model = settings.models[settings.provider]

  const drafts: AiStepDraft[] = []
  const total = request.steps.length

  for (let i = 0; i < total; i += CHUNK_SIZE) {
    const chunk = request.steps.slice(i, i + CHUNK_SIZE)
    try {
      const parts = await buildParts(request, chunk, settings.useScreenshot)
      if (process.env['DOCRECORDER_AI_FAKE']) {
        const prompt = parts
          .map((part) => (part.kind === 'text' ? part.text : ''))
          .join('\n')
        drafts.push(...fakeDrafts(chunk, prompt))
      } else {
        const raw =
          settings.provider === 'anthropic'
            ? await draftWithClaude(apiKey, model, parts)
            : await draftWithGemini(apiKey, model, parts)
        drafts.push(...parseDrafts(raw, chunk.map((step) => step.id)))
      }
    } catch (err) {
      // Lo ya redactado se devuelve: en una grabación larga es preferible
      // aprovechar los primeros lotes a perderlos por un fallo del último.
      return { drafts, error: explain(err) }
    }
    onProgress({ done: Math.min(i + chunk.length, total), total })
  }

  return { drafts }
}
