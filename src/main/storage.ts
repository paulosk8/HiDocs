import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SavePayload } from '../shared/ipc-contract'
import type { DocSession, DocStep, Flow, FlowAction, SaveResult, Viewport } from '../shared/types'

/**
 * Escritura del paquete portable en disco (§7):
 *
 *   <carpeta>/<module>/<feature>/
 *     ├── session.json
 *     ├── flow.json
 *     └── img/paso-01.png …
 */

/** kebab-case para nombres de carpeta, sin acentos ni caracteres de ruta. */
export function kebab(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'sin-nombre'
}

/** `paso-01.png`, con cero a la izquierda hasta 99 pasos. */
export function imageName(order: number): string {
  return `paso-${String(order).padStart(2, '0')}.png`
}

export async function saveSession(
  payload: SavePayload,
  actualViewport: Viewport
): Promise<SaveResult> {
  const moduleDir = kebab(payload.meta.module)
  const featureDir = kebab(payload.meta.feature)
  const targetDir = join(payload.outputDir, moduleDir, featureDir)
  const imgDir = join(targetDir, 'img')

  await mkdir(imgDir, { recursive: true })

  // El orden en disco debe coincidir siempre con el orden final del panel: las
  // imágenes se renumeran al guardar, no al reordenar (§7).
  const steps: DocStep[] = []
  const actions: FlowAction[] = []
  let imagesWritten = 0

  for (const [index, step] of payload.steps.entries()) {
    const order = index + 1
    const relative = `img/${imageName(order)}`

    try {
      await copyFile(step.tempFile, join(targetDir, relative))
      imagesWritten++
    } catch {
      // Un paso sin captura sigue siendo válido como acción del flujo; se anota
      // la ruta esperada para que el hueco sea visible al revisar.
    }

    const persisted: DocStep = {
      id: step.id,
      order,
      action: step.action,
      title: step.title,
      description: step.description,
      selectorCandidates: step.selectorCandidates,
      url: step.url,
      screenshot: relative,
      boundingRect: step.boundingRect,
      includeInDocs: step.includeInDocs,
      timestamp: step.timestamp
    }
    if (step.value !== undefined) persisted.value = step.value
    steps.push(persisted)

    const action: FlowAction = {
      order,
      action: step.action,
      selectorCandidates: step.selectorCandidates,
      url: step.url
    }
    if (step.value !== undefined) action.value = step.value
    actions.push(action)
  }

  const session: DocSession = {
    id: payload.sessionId,
    module: moduleDir,
    feature: featureDir,
    title: payload.meta.title,
    role: payload.meta.role,
    baseUrl: payload.meta.baseUrl,
    // Se guarda el tamaño real del viewport, no el nominal: es el que hace
    // reproducible la captura en el runner futuro.
    viewport: actualViewport.width > 0 ? actualViewport : payload.viewport,
    createdAt: payload.createdAt,
    steps
  }

  const flow: Flow = {
    sessionId: session.id,
    module: session.module,
    feature: session.feature,
    baseUrl: session.baseUrl,
    viewport: session.viewport,
    actions
  }

  await writeFile(join(targetDir, 'session.json'), JSON.stringify(session, null, 2), 'utf8')
  await writeFile(join(targetDir, 'flow.json'), JSON.stringify(flow, null, 2), 'utf8')

  return { path: targetDir, stepsWritten: steps.length, imagesWritten }
}
