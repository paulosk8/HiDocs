import { readFile } from 'node:fs/promises'
import type { AiDraftRequest, AiStepInput } from '../../shared/ipc-contract'
import type { AiDraftResult, AiStepDraft } from '../../shared/types'
import { aiSettings, getAiKey } from '../settings'
import { contextText, parseDrafts, stepText, type PromptPart } from './prompt'
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
 */
function fakeDrafts(chunk: AiStepInput[]): AiStepDraft[] {
  return chunk.map((step) => ({
    id: step.id,
    title: `Redactado: ${step.title || step.action}`,
    description: `Descripción generada para el paso ${step.order} (${step.action}).`
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
  const model = settings.models[settings.provider]

  const drafts: AiStepDraft[] = []
  const total = request.steps.length

  for (let i = 0; i < total; i += CHUNK_SIZE) {
    const chunk = request.steps.slice(i, i + CHUNK_SIZE)
    try {
      if (process.env['DOCRECORDER_AI_FAKE']) {
        drafts.push(...fakeDrafts(chunk))
      } else {
        const parts = await buildParts(request, chunk, settings.useScreenshot)
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
