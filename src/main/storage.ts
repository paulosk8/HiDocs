import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SavePayload } from '../shared/ipc-contract'
import { commitDocs } from './git'
import { rememberProject } from './projects'
import { slug } from '../shared/naming'
import type { DocSession, DocStep, Flow, FlowAction, SaveResult, Viewport } from '../shared/types'

/**
 * Escritura del paquete portable en disco (§7):
 *
 *   <carpeta>/<module>/<feature>/
 *     ├── session.json
 *     ├── flow.json
 *     └── img/paso-01.png …
 */

/** kebab-case para nombres de carpeta; nunca vacío, para no generar rutas rotas. */
export function kebab(value: string): string {
  return slug(value) || 'sin-nombre'
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
  /** rutas absolutas de las capturas copiadas, para indexarlas en Git */
  const writtenImages: string[] = []
  let imagesWritten = 0

  for (const [index, step] of payload.steps.entries()) {
    const order = index + 1
    const relative = `img/${imageName(order)}`

    try {
      const destination = join(targetDir, relative)
      await copyFile(step.tempFile, destination)
      writtenImages.push(destination)
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

  const sessionFile = join(targetDir, 'session.json')
  const flowFile = join(targetDir, 'flow.json')
  await writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf8')
  await writeFile(flowFile, JSON.stringify(flow, null, 2), 'utf8')

  const result: SaveResult = { path: targetDir, stepsWritten: steps.length, imagesWritten }

  if (payload.git?.enabled) {
    // El paquete en disco ya está escrito y es válido por sí solo. Si el commit
    // falla, se informa del motivo pero no se deshace nada: perder la grabación
    // por un problema del repositorio sería mucho peor que quedarse sin commit.
    try {
      result.git = await commitDocs({
        repoRoot: payload.outputDir,
        branch: payload.git.branch,
        message: payload.git.message,
        push: payload.git.push,
        baseBranch: payload.git.baseBranch,
        files: [sessionFile, flowFile, ...writtenImages]
      })
      // El repositorio se recuerda solo cuando el commit sale bien: registrar un
      // repositorio en el que no se ha llegado a escribir nada ensuciaría la
      // lista con intentos fallidos.
      await rememberProject(result.git.repoRoot, payload.outputDir)
    } catch (err) {
      result.gitError = err instanceof Error ? err.message : String(err)
    }
  }

  return result
}
