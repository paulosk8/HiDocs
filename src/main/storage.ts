import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SavePayload } from '../shared/ipc-contract'
import { commitDocs } from './git'
import { rememberProject } from './projects'
import { kebab } from '../shared/naming'
import { categoryJson, renderFeatureMdx, titleCase } from './mdx'
import { detectChecks, runChecks } from './checks'
import type { CheckProgress, DocSession, DocStep, SaveResult, Viewport } from '../shared/types'

/**
 * Escritura del paquete en disco (§7). Además del registro de la sesión en JSON,
 * se genera la página del manual en MDX para que Docusaurus la renderice (§10):
 *
 *   <carpeta>/<module>/[<subcategory>/]
 *     ├── _category_.json          (etiqueta de la barra lateral; solo si falta;
 *     │                             uno por cada nivel con carpeta propia)
 *     └── <feature>/
 *         ├── index.mdx            (la página del manual, para Docusaurus)
 *         ├── session.json         (la sesión completa: pasos y selectores)
 *         └── img/paso-01.png …
 */

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

/** `paso-01.png`, con cero a la izquierda hasta 99 pasos. */
export function imageName(order: number): string {
  return `paso-${String(order).padStart(2, '0')}.png`
}

export async function saveSession(
  payload: SavePayload,
  actualViewport: Viewport,
  onCheckProgress: (progress: CheckProgress) => void = () => {}
): Promise<SaveResult> {
  const moduleDir = kebab(payload.meta.module)
  const featureDir = kebab(payload.meta.feature)
  // La subcategoría es opcional: si el usuario no la escribe, la estructura
  // sigue siendo de dos niveles (módulo/funcionalidad), igual que antes.
  const subDir = payload.meta.subcategory?.trim() ? kebab(payload.meta.subcategory) : ''
  const targetDir = subDir
    ? join(payload.outputDir, moduleDir, subDir, featureDir)
    : join(payload.outputDir, moduleDir, featureDir)
  const imgDir = join(targetDir, 'img')

  await mkdir(imgDir, { recursive: true })

  // El orden en disco debe coincidir siempre con el orden final del panel: las
  // imágenes se renumeran al guardar, no al reordenar (§7).
  const steps: DocStep[] = []
  /** rutas absolutas de las capturas copiadas, para indexarlas en Git */
  const writtenImages: string[] = []
  /** rutas relativas escritas, para que el MDX no enlace capturas inexistentes */
  const writtenRelatives = new Set<string>()
  let imagesWritten = 0

  for (const [index, step] of payload.steps.entries()) {
    const order = index + 1
    // Ni un bloque de contenido, ni un separador de sección, ni una carpeta de
    // capturas tienen imagen que copiar ni hueco que reservar en `img/`: son
    // prosa, estructura y agrupación (las imágenes de la carpeta son las de los
    // pasos que contiene). Los demás pasos —los grabados y las capturas
    // externas— sí, y conservan la numeración del paso para poder rastrearlos.
    const hasShot = step.kind !== 'content' && step.kind !== 'section' && step.kind !== 'group'
    const relative = hasShot ? `img/${imageName(order)}` : ''

    if (hasShot) {
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
    // Solo se anota lo que NO es una interacción grabada: así las sesiones ya
    // commiteadas siguen leyéndose igual y el JSON no engorda sin motivo.
    if (step.kind && step.kind !== 'interaction') persisted.kind = step.kind
    // La pertenencia a una carpeta viaja con el paso: es lo que permite volver a
    // editar el paquete sin que las carpetas se deshagan.
    if (step.groupId) persisted.groupId = step.groupId
    if (step.content?.trim()) persisted.content = step.content
    if (step.value !== undefined) persisted.value = step.value
    if (step.fields?.length) persisted.fields = step.fields
    // La nota destacada se conserva solo si tiene cuerpo: un recuadro vacío no
    // aporta nada al manual y ensuciaría el MDX.
    if (step.note?.body.trim()) persisted.note = step.note
    // Las acciones individuales del paso agrupado se conservan: son las que
    // localizan a cada uno de sus elementos si el paquete se vuelve a editar y
    // hay que re-capturarlo con todos ellos señalados.
    if (step.mergedActions?.length) persisted.mergedActions = step.mergedActions
    steps.push(persisted)
  }

  const session: DocSession = {
    id: payload.sessionId,
    module: moduleDir,
    ...(subDir ? { subcategory: subDir } : {}),
    feature: featureDir,
    title: payload.meta.title,
    role: payload.meta.role,
    baseUrl: payload.meta.baseUrl,
    // Se guarda el tamaño real del viewport, no el nominal: es a lo que
    // corresponden las capturas del paquete.
    viewport: actualViewport.width > 0 ? actualViewport : payload.viewport,
    createdAt: payload.createdAt,
    steps
  }

  const sessionFile = join(targetDir, 'session.json')
  await writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf8')

  // Página del manual para Docusaurus. Las etiquetas de módulo y subcategoría se
  // toman del texto original del usuario (no del slug de carpeta), para que se
  // lean bien.
  const moduleLabel = titleCase(payload.meta.module) || moduleDir
  const subLabel = subDir ? titleCase(payload.meta.subcategory) || subDir : ''
  const mdxFile = join(targetDir, 'index.mdx')
  await writeFile(
    mdxFile,
    renderFeatureMdx(session, moduleLabel, (rel) => writtenRelatives.has(rel), subLabel),
    'utf8'
  )
  const committedFiles = [mdxFile, sessionFile, ...writtenImages]

  // Las categorías agrupan las funcionalidades en la barra lateral. Cada nivel
  // con carpeta propia lleva su `_category_.json`, creado solo si falta: si el
  // mantenedor ya lo personalizó, no se pisa. Con subcategoría son dos.
  const categoryFile = join(payload.outputDir, moduleDir, '_category_.json')
  if (!(await exists(categoryFile))) {
    await writeFile(categoryFile, categoryJson(moduleLabel), 'utf8')
    committedFiles.push(categoryFile)
  }
  if (subDir) {
    const subCategoryFile = join(payload.outputDir, moduleDir, subDir, '_category_.json')
    if (!(await exists(subCategoryFile))) {
      await writeFile(subCategoryFile, categoryJson(subLabel), 'utf8')
      committedFiles.push(subCategoryFile)
    }
  }

  const result: SaveResult = { path: targetDir, stepsWritten: steps.length, imagesWritten }

  // Comprobación del sitio ANTES del commit (§17). El orden es deliberado: los
  // comandos se ejecutan sobre el paquete ya escrito —es lo que van a compilar—,
  // y si algo no pasa, el commit no llega a hacerse. Lo escrito se queda en
  // disco: se corrige y se vuelve a guardar, o se registra igualmente desde el
  // aviso. Sin proyecto Docusaurus alrededor no hay nada que ejecutar y guardar
  // sigue siendo lo de siempre.
  if (payload.git?.enabled && payload.git.verify !== false) {
    const project = await detectChecks(payload.outputDir).catch(() => null)
    if (project && project.checks.length) {
      result.checks = await runChecks(project.projectRoot, project.checks, onCheckProgress)
      if (!result.checks.ok) return result
    }
  }

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
