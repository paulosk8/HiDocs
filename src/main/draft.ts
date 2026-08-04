import { app } from 'electron'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DraftPayload } from '../shared/ipc-contract'

/**
 * Borrador de la grabación en curso, para poder cerrar la app y continuar otro
 * día. Vive en `userData`, no en el repositorio: es trabajo sin terminar de esta
 * máquina, y solo se registra en Git al finalizar.
 *
 * Las capturas se copian a una carpeta durable (`draft/img`) porque las
 * temporales del motor se borran al cerrar. El borrador se descarta al guardar
 * con éxito o al descartarlo el usuario.
 */

function dir(): string {
  return join(app.getPath('userData'), 'draft')
}
function file(): string {
  return join(dir(), 'draft.json')
}
function imgDir(): string {
  return join(dir(), 'img')
}

async function newerOrMissing(src: string, dest: string): Promise<boolean> {
  const [s, d] = await Promise.all([stat(src).catch(() => null), stat(dest).catch(() => null)])
  return !!s && (!d || s.mtimeMs > d.mtimeMs)
}

/**
 * Guarda el borrador. Copia la captura de cada paso a `draft/img/<id>.png`
 * (durable) y guarda esa ruta, para que el borrador sobreviva al cierre.
 */
export async function saveDraft(draft: DraftPayload): Promise<void> {
  await mkdir(imgDir(), { recursive: true })

  /** Copia la captura del paso a la carpeta durable y devuelve su ruta nueva. */
  const persistShot = async <T extends { id: string; tempFile: string }>(step: T): Promise<T> => {
    const dest = join(imgDir(), `${step.id}.png`)
    if (step.tempFile && step.tempFile !== dest && (await newerOrMissing(step.tempFile, dest))) {
      await copyFile(step.tempFile, dest).catch(() => undefined)
    }
    const stored = await stat(dest)
      .then(() => true)
      .catch(() => false)
    return { ...step, tempFile: stored ? dest : step.tempFile }
  }

  const steps = await Promise.all(
    draft.steps.map(async (step) => {
      const saved = await persistShot(step)
      // Los pasos que quedaron dentro de una agrupación manual conservan su
      // propia captura: es lo que devuelve «deshacer agrupación», y sin copiarla
      // aquí deshacerla mañana dejaría los pasos sin imagen.
      if (!step.groupSources?.length) return saved
      return { ...saved, groupSources: await Promise.all(step.groupSources.map(persistShot)) }
    })
  )

  const tmp = `${file()}.tmp`
  await writeFile(tmp, JSON.stringify({ ...draft, steps }, null, 2), 'utf8')
  await rename(tmp, file())
}

/** Lee el borrador, o `null` si no hay ninguno con pasos. */
export async function loadDraft(): Promise<DraftPayload | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as DraftPayload).steps) ||
      !(parsed as DraftPayload).steps.length
    ) {
      return null
    }
    return parsed as DraftPayload
  } catch {
    return null
  }
}

/** Descarta el borrador (al guardar con éxito o si el usuario lo desecha). */
export async function clearDraft(): Promise<void> {
  await rm(dir(), { recursive: true, force: true }).catch(() => undefined)
}
