/**
 * Convenciones de nombres compartidas por main y renderer.
 *
 * Viven aquí porque la GUI necesita mostrar la rama y el mensaje sugeridos antes
 * de guardar, y main necesita los mismos valores como respaldo si la GUI no los
 * envía. Duplicar la lógica dejaría que divergieran.
 */

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

/** Rama sugerida: `docs/<modulo>-<funcionalidad>`. */
export function suggestBranchName(module: string, feature: string): string {
  const parts = [slug(module), slug(feature)].filter(Boolean)
  return `docs/${parts.join('-') || 'sesion'}`
}

/** Mensaje de commit sugerido, en el mismo estilo semántico del repositorio. */
export function suggestCommitMessage(module: string, feature: string, title: string): string {
  const scope = slug(module) || 'docs'
  const subject = title.trim() || slug(feature).replace(/-/g, ' ') || 'nueva guía'
  return `docs(${scope}): ${subject}`
}
