import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  AI_MODELS,
  AI_PROVIDERS,
  DEFAULT_AI_SETTINGS,
  apiKeyProblem,
  type AiProvider,
  type AiSettings,
  type AiStatus
} from '../shared/types'

/**
 * Preferencias de la aplicación que deben sobrevivir al cierre y que no pueden
 * vivir en el renderer: la clave de la API de IA, sobre todo.
 *
 * Vive en `userData/settings.json`, nunca en el repositorio de documentación: es
 * configuración de esta máquina, y una clave commiteada sería un incidente.
 *
 * Las claves se cifran con `safeStorage`, que delega en el llavero del sistema
 * (Llaveros en macOS, DPAPI en Windows, libsecret en Linux). Si el sistema no
 * ofrece cifrado —ocurre en algunos Linux sin llavero— se guardan en claro antes
 * que perder la función, y la GUI lo advierte.
 */

interface StoredSettings {
  ai: AiSettings & { keys: Partial<Record<AiProvider, string>> }
}

const KEY_ENCRYPTED = 'enc:'
const KEY_PLAIN = 'raw:'

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function defaults(): StoredSettings {
  return { ai: { ...DEFAULT_AI_SETTINGS, models: { ...DEFAULT_AI_SETTINGS.models }, keys: {} } }
}

/** Un proveedor o modelo desconocido (archivo editado a mano, versión anterior). */
function sanitizeProvider(value: unknown): AiProvider {
  return AI_PROVIDERS.includes(value as AiProvider)
    ? (value as AiProvider)
    : DEFAULT_AI_SETTINGS.provider
}

function sanitizeModel(provider: AiProvider, value: unknown): string {
  return typeof value === 'string' && AI_MODELS[provider].includes(value)
    ? value
    : AI_MODELS[provider][0]
}

async function read(): Promise<StoredSettings> {
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as Partial<StoredSettings>
    const ai = parsed.ai ?? {}
    const provider = sanitizeProvider((ai as AiSettings).provider)
    const models = (ai as AiSettings).models ?? {}
    return {
      ai: {
        provider,
        models: {
          anthropic: sanitizeModel('anthropic', models.anthropic),
          gemini: sanitizeModel('gemini', models.gemini)
        },
        useScreenshot: (ai as AiSettings).useScreenshot !== false,
        keys: (ai as StoredSettings['ai']).keys ?? {}
      }
    }
  } catch {
    // No hay archivo todavía, o quedó ilegible: se parte de los valores por
    // defecto en vez de dejar la aplicación sin configuración de IA.
    return defaults()
  }
}

async function write(settings: StoredSettings): Promise<void> {
  await mkdir(dirname(file()), { recursive: true })
  const tmp = `${file()}.tmp`
  await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
  await rename(tmp, file())
}

function toStatus(settings: StoredSettings): AiStatus {
  const { keys, ...ai } = settings.ai
  const configured = {
    anthropic: !!keys.anthropic,
    gemini: !!keys.gemini
  }
  return {
    settings: ai,
    configured,
    ready: configured[ai.provider],
    encrypted: safeStorage.isEncryptionAvailable()
  }
}

export async function aiStatus(): Promise<AiStatus> {
  return toStatus(await read())
}

/**
 * Guarda la clave de un proveedor; una cadena vacía la borra. Una clave que no
 * puede serlo no se guarda: es preferible decirlo al pegarla que fallar después,
 * a mitad de una redacción, con el error que devuelva la API.
 */
export async function setAiKey(provider: AiProvider, key: string): Promise<AiStatus> {
  const settings = await read()
  const trimmed = key.trim()
  const problem = apiKeyProblem(trimmed)
  if (problem) throw new Error(problem)
  if (!trimmed) {
    delete settings.ai.keys[provider]
  } else if (safeStorage.isEncryptionAvailable()) {
    settings.ai.keys[provider] = KEY_ENCRYPTED + safeStorage.encryptString(trimmed).toString('base64')
  } else {
    settings.ai.keys[provider] = KEY_PLAIN + trimmed
  }
  await write(settings)
  return toStatus(settings)
}

/** Clave en claro para llamar a la API, o `null` si no hay ninguna guardada. */
export async function getAiKey(provider: AiProvider): Promise<string | null> {
  const stored = (await read()).ai.keys[provider]
  if (!stored) return null
  if (stored.startsWith(KEY_PLAIN)) return stored.slice(KEY_PLAIN.length)
  if (!stored.startsWith(KEY_ENCRYPTED)) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(KEY_ENCRYPTED.length), 'base64'))
  } catch {
    // El llavero puede haber cambiado (otro usuario, perfil restaurado): la
    // clave ya no se puede descifrar y hay que volver a introducirla.
    return null
  }
}

export async function setAiSettings(patch: Partial<AiSettings>): Promise<AiStatus> {
  const settings = await read()
  if (patch.provider !== undefined) settings.ai.provider = sanitizeProvider(patch.provider)
  if (patch.useScreenshot !== undefined) settings.ai.useScreenshot = !!patch.useScreenshot
  if (patch.models) {
    for (const provider of AI_PROVIDERS) {
      const model = patch.models[provider]
      if (model !== undefined) settings.ai.models[provider] = sanitizeModel(provider, model)
    }
  }
  await write(settings)
  return toStatus(settings)
}

/** Ajustes de IA ya saneados, para quien va a hacer la llamada (sin las claves). */
export async function aiSettings(): Promise<AiSettings> {
  const stored = (await read()).ai
  return {
    provider: stored.provider,
    models: stored.models,
    useScreenshot: stored.useScreenshot
  }
}
