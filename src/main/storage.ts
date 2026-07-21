import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SavePayload } from '../shared/ipc-contract'
import { commitDocs } from './git'
import { rememberProject } from './projects'
import { slug } from '../shared/naming'
import { categoryJson, renderFeatureMdx, titleCase } from './mdx'
import type { DocSession, DocStep, Flow, FlowAction, SaveResult, Viewport } from '../shared/types'

/**
 * Escritura del paquete en disco (§7). Además del paquete reproducible en JSON,
 * se genera la página del manual en MDX para que Docusaurus la renderice (§10):
 *
 *   <carpeta>/<module>/
 *     ├── _category_.json          (etiqueta de la barra lateral; solo si falta)
 *     └── <feature>/
 *         ├── index.mdx            (la página del manual, para Docusaurus)
 *         ├── session.json         (sesión completa, reproducible)
 *         ├── flow.json            (acciones + selectores)
 *         └── img/paso-01.png …
 */

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

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
  /** rutas relativas escritas, para que el MDX no enlace capturas inexistentes */
  const writtenRelatives = new Set<string>()
  let imagesWritten = 0

  for (const [index, step] of payload.steps.entries()) {
    const order = index + 1
    const relative = `img/${imageName(order)}`

    try {
      const destination = join(targetDir, relative)
      await copyFile(step.tempFile, destination)
      writtenImages.push(destination)
      writtenRelatives.add(relative)
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
    if (step.fields?.length) persisted.fields = step.fields
    // El runner necesita las acciones individuales del paso agrupado para
    // reproducirlo (una captura tras re-ejecutarlas todas).
    if (step.mergedActions?.length) persisted.mergedActions = step.mergedActions
    steps.push(persisted)

    // flow.json es la receta reproducible para el runner: un paso de formulario
    // agrupado se expande en sus acciones individuales (una por campo), aunque en
    // el manual sea un solo paso. Los demás pasos aportan una acción.
    const stepActions =
      step.mergedActions && step.mergedActions.length > 0
        ? step.mergedActions
        : [
            {
              order,
              action: step.action,
              selectorCandidates: step.selectorCandidates,
              url: step.url,
              ...(step.value !== undefined ? { value: step.value } : {})
            }
          ]
    for (const a of stepActions) {
      actions.push({ ...a, order: actions.length + 1 })
    }
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

  // Página del manual para Docusaurus. La etiqueta del módulo se toma del texto
  // original del usuario (no del slug de carpeta), para que se lea bien.
  const moduleLabel = titleCase(payload.meta.module) || moduleDir
  const mdxFile = join(targetDir, 'index.mdx')
  await writeFile(
    mdxFile,
    renderFeatureMdx(session, moduleLabel, (rel) => writtenRelatives.has(rel)),
    'utf8'
  )
  const committedFiles = [mdxFile, sessionFile, flowFile, ...writtenImages]

  // La categoría agrupa las funcionalidades del módulo en la barra lateral. Solo
  // se crea si falta: si el mantenedor ya la personalizó, no se pisa.
  const categoryFile = join(payload.outputDir, moduleDir, '_category_.json')
  if (!(await exists(categoryFile))) {
    await writeFile(categoryFile, categoryJson(moduleLabel), 'utf8')
    committedFiles.push(categoryFile)
  }

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
        files: committedFiles
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
