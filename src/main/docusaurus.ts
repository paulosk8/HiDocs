import { access } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Detección de proyectos Docusaurus, para evitar el error más común: elegir como
 * carpeta de salida la RAÍZ del proyecto en vez de su carpeta `docs/`. Docusaurus
 * solo renderiza lo que hay en `docs/`, así que un paquete escrito en la raíz no
 * aparece en el sitio y parece que «no funciona».
 */

const CONFIG_NAMES = [
  'docusaurus.config.js',
  'docusaurus.config.ts',
  'docusaurus.config.mjs',
  'docusaurus.config.cjs'
]

function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

/**
 * Si `dir` es la raíz de un proyecto Docusaurus (tiene su archivo de
 * configuración y una carpeta `docs/`), devuelve la ruta de esa `docs/`: es
 * donde la documentación sí se renderiza. En cualquier otro caso devuelve `null`
 * —no es Docusaurus, o ya se está apuntando dentro de `docs/`, donde no hay
 * archivo de configuración—, y entonces no se muestra ningún aviso.
 */
export async function suggestDocsDir(dir: string): Promise<string | null> {
  if (!dir) return null
  const hasConfig = (await Promise.all(CONFIG_NAMES.map((n) => exists(join(dir, n))))).some(Boolean)
  if (!hasConfig) return null
  const docs = join(dir, 'docs')
  return (await exists(docs)) ? docs : null
}
