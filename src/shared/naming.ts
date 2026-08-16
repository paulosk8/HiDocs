/**
 * Convenciones de nombres compartidas por main y renderer.
 *
 * Viven aquí porque la GUI necesita mostrar la rama y el mensaje sugeridos antes
 * de guardar, y main necesita los mismos valores como respaldo si la GUI no los
 * envía. Duplicar la lógica dejaría que divergieran.
 */

/** `crear-matricula` o `Crear matricula` → `Crear Matricula`. Etiqueta legible. */
export function titleCase(text: string): string {
  return text
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** kebab-case sin acentos ni caracteres de ruta. */
export function slug(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized
}

/** kebab-case para nombres de carpeta; nunca vacío, para no generar rutas rotas. */
export function kebab(value: string): string {
  return slug(value) || 'sin-nombre'
}

/**
 * Carpetas del paquete de una funcionalidad, tal como se escriben en disco: la
 * subcategoría solo aparece si el usuario la ha puesto.
 *
 * Lo usan el guardado (para escribir) y la vista previa (para encontrar la
 * página ya compilada y abrirla): la ruta debe ser la misma o la vista previa
 * abriría la portada del sitio en vez de la guía.
 */
export function featureSegments(module: string, subcategory: string, feature: string): string[] {
  const segments = [kebab(module)]
  if (subcategory.trim()) segments.push(kebab(subcategory))
  segments.push(kebab(feature))
  return segments
}

/**
 * Rama sugerida: `docs/<modulo>`, una por módulo.
 *
 * Todas las funcionalidades de un mismo módulo se acumulan en su rama (la app
 * reutiliza una rama existente y añade el commit encima), de modo que el módulo
 * es la unidad de PR. La categorización del manual la da la estructura de
 * carpetas `<modulo>/<funcionalidad>/`, no la rama.
 */
export function suggestBranchName(module: string): string {
  return `docs/${slug(module) || 'sesion'}`
}

/**
 * Git rechaza estos patrones en `check-ref-format`; se avisa antes de intentarlo.
 *
 * Vive aquí, y no en el módulo Git del main, porque el selector de rama de la
 * GUI valida lo que se escribe mientras se escribe: repetir la regla en el
 * renderer dejaría que las dos versiones divergieran.
 */
export function validateBranchName(name: string): string | null {
  if (!name.trim()) return 'El nombre de la rama no puede estar vacío.'
  if (/\s/.test(name)) return 'El nombre de la rama no puede contener espacios.'
  if (/\.\.|@\{|^-|\/$|\.$|\.lock$/.test(name) || /[~^:?*[\\]/.test(name)) {
    return 'El nombre de la rama contiene caracteres que Git no admite.'
  }
  return null
}

/** Mensaje de commit sugerido, en el mismo estilo semántico del repositorio. */
export function suggestCommitMessage(module: string, feature: string, title: string): string {
  const scope = slug(module) || 'docs'
  const subject = title.trim() || slug(feature).replace(/-/g, ' ') || 'nueva guía'
  return `docs(${scope}): ${subject}`
}
