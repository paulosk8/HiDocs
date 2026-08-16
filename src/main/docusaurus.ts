import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
  if (!(await hasDocusaurusConfig(dir))) return null
  const docs = join(dir, 'docs')
  return (await exists(docs)) ? docs : null
}

/** ¿Hay un `docusaurus.config.*` en esta carpeta? */
async function hasDocusaurusConfig(dir: string): Promise<boolean> {
  return (await Promise.all(CONFIG_NAMES.map((n) => exists(join(dir, n))))).some(Boolean)
}

/** Cuántos niveles se sube buscando la raíz. `docs/<módulo>/<sub>/<funcionalidad>` son cuatro. */
const MAX_LEVELS = 8

/**
 * Raíz del proyecto Docusaurus que contiene `dir`, subiendo por sus carpetas.
 *
 * La carpeta de salida es `<proyecto>/docs`, y al reeditar puede ser aún más
 * honda; los comandos (`npm run build`, `npm run serve`) hay que ejecutarlos
 * arriba, donde están el `package.json` y la configuración. Se exigen los dos:
 * con solo el `package.json` podríamos estar en un repositorio cualquiera y
 * ejecutar un `build` que no tiene nada que ver con la documentación.
 */
export async function findProjectRoot(dir: string): Promise<string | null> {
  let current = dir
  for (let level = 0; level < MAX_LEVELS && current; level++) {
    if ((await hasDocusaurusConfig(current)) && (await exists(join(current, 'package.json')))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}
