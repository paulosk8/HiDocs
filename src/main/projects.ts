import { app } from 'electron'
import { readFile, writeFile, rename, access } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { ProjectEntry } from '../shared/types'

/**
 * Registro de los repositorios de documentación ya usados.
 *
 * Existe para una sola cosa: que al abrir la app no haya que volver a buscar la
 * carpeta en el disco. NO gestiona repositorios —no clona, no crea, no borra
 * nada— y por eso «olvidar» un proyecto solo lo quita de esta lista; el
 * repositorio sigue intacto donde estaba.
 *
 * Se guarda en `userData`, no dentro del repositorio: es una preferencia de esta
 * máquina, y escribir un archivo de estado en un repositorio ajeno sería
 * exactamente lo que el resto del código se cuida de no hacer.
 */

const FILE_NAME = 'projects.json'
/** Cota para que el registro no crezca sin fin en un uso prolongado. */
const MAX_ENTRIES = 40

function file(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

async function readAll(): Promise<ProjectEntry[]> {
  try {
    const raw = await readFile(file(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // El archivo es editable a mano y sobrevive a cambios de versión: se filtra
    // lo que no encaje en vez de propagar entradas rotas a la interfaz.
    return parsed.filter(
      (e): e is ProjectEntry =>
        !!e && typeof e === 'object' && typeof (e as ProjectEntry).root === 'string'
    )
  } catch {
    return [] // no existe todavía, o está corrupto: se parte de cero
  }
}

async function writeAll(entries: ProjectEntry[]): Promise<void> {
  // Escritura en dos pasos: si la app muere a mitad, el archivo bueno sigue
  // intacto en vez de quedar truncado.
  const target = file()
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8')
  await rename(tmp, target)
}

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

/**
 * Lista los proyectos, del más usado recientemente al más antiguo.
 *
 * Las carpetas que ya no están se marcan como ausentes en vez de ocultarse: si
 * el usuario movió el repositorio, es más útil verlo con un aviso que verlo
 * desaparecer sin explicación.
 */
export async function listProjects(): Promise<ProjectEntry[]> {
  const entries = await readAll()
  const checked = await Promise.all(
    entries.map(async (e) => ({ ...e, missing: !(await exists(e.root)) }))
  )
  return checked.sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
}

/** Añade el repositorio al registro, o actualiza su fecha de uso si ya estaba. */
export async function rememberProject(root: string, outputDir: string): Promise<void> {
  if (!root) return
  const entries = (await readAll()).filter((e) => e.root !== root)
  entries.unshift({
    root,
    label: basename(root) || root,
    lastUsedAt: new Date().toISOString(),
    lastOutputDir: outputDir || root
  })
  await writeAll(entries.slice(0, MAX_ENTRIES))
}

/** Quita el repositorio de la lista. No toca el repositorio en disco. */
export async function forgetProject(root: string): Promise<void> {
  await writeAll((await readAll()).filter((e) => e.root !== root))
}
