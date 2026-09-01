/**
 * Modelo de datos del grabador (§6 de SPEC.md).
 * Este archivo es compartido por main, preload y renderer: no debe importar
 * nada de Node ni del DOM.
 */

/**
 * Lo que ocurrió en el paso. Las seis primeras son interacciones con la página;
 * `capture`, `image`, `content`, `section` y `group` solo salen en los pasos que
 * añade el usuario a mano, donde no hay ninguna interacción que describir.
 */
export type StepAction =
  | 'click'
  | 'fill'
  | 'select'
  | 'submit'
  | 'press'
  | 'navigate'
  | 'capture'
  | 'image'
  | 'content'
  | 'section'
  | 'group'

/**
 * De dónde sale un paso y, por tanto, qué se puede hacer con él.
 *
 * - `interaction`: lo grabó el motor sobre la página. Tiene acción y selectores.
 * - `capture`: una captura de pantalla ajena a la página (otra ventana, el
 *   escritorio o un archivo de imagen). Documenta lo que no vive en el navegador
 *   y no tiene acción ni selectores.
 * - `image`: una imagen que el usuario trajo pegada desde el portapapeles. Se
 *   comporta igual que `capture` —imagen propia, sin acción— pero se distingue
 *   porque su origen no es la pantalla de esta máquina:
 *   es un diagrama, un recorte de otra herramienta o una captura que ya venía
 *   hecha, y eso cambia lo que se puede dar por supuesto al describirla.
 * - `content`: un bloque de contenido escrito a mano (una tabla, un fragmento de
 *   código, un aviso…). No tiene captura ni acción: es prosa del manual.
 * - `section`: un separador con título. No documenta nada por sí mismo: agrupa
 *   los pasos que van DEBAJO de él hasta la sección siguiente, para poder
 *   plegarlos, moverlos en bloque y publicar el manual por apartados. Es el único
 *   paso que no se numera.
 * - `group`: una **carpeta de capturas**. Es UN paso del manual —se numera, se
 *   titula y se describe— cuyas ilustraciones son las de los pasos que se han
 *   metido dentro (`groupId`). Sirve para lo que el motor no puede adivinar: que
 *   cuatro pantallazos sueltos cuentan una sola cosa. A diferencia de agrupar
 *   pasos (⊞), que funde acciones y deja UNA captura, aquí se conservan todas las
 *   imágenes y cada una puede llevar su pie. La carpeta no tiene captura propia.
 *
 * Ausente en las sesiones anteriores a esta función: se lee como `interaction`.
 */
export type StepKind = 'interaction' | 'capture' | 'image' | 'content' | 'section' | 'group'

export type SelectorStrategy = 'testid' | 'id' | 'role' | 'text' | 'css'

export interface SelectorCandidate {
  strategy: SelectorStrategy
  value: string
  /** 0-100, robustez estimada. Mayor = más estable frente a cambios de UI. */
  score: number
}

export interface BoundingRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DocStep {
  id: string
  order: number
  action: StepAction
  /** origen del paso; ausente = `interaction` (lo grabó el motor) */
  kind?: StepKind
  title: string
  description: string
  selectorCandidates: SelectorCandidate[]
  /** para fill/select ("***" si es password) */
  value?: string
  /**
   * Lo que se fundió en este paso, listado en el manual como etiqueta (+ valor
   * si lo hay). Son los campos de un formulario cuando la GUI une varios
   * `fill`/`select` seguidos, y el título de cada acción cuando el usuario
   * agrupa a mano pasos de cualquier otro tipo (botones, filas de una tabla, un
   * selector con su opción…). Mientras hay `fields`, `value` deja de usarse.
   */
  fields?: Array<{ label: string; value: string }>
  /**
   * Acciones individuales que se fundieron en este paso (agrupado): con ellas se
   * vuelve a localizar cada uno de sus elementos para señalarlos todos en la
   * captura. Ausente en pasos no agrupados: su acción es `action` +
   * `selectorCandidates` + `value`.
   */
  mergedActions?: RecordedAction[]
  /**
   * Nota destacada del paso, publicada como «admonition» de Docusaurus
   * (`:::note`, `:::tip`, …). Sirve para recalcar algo importante de este paso
   * o del grupo. El cuerpo se redacta en Markdown/MDX; ausente si no hay nota.
   */
  note?: StepNote
  /**
   * Bloque de contenido del paso, en Markdown/MDX: una tabla, un fragmento de
   * código, pestañas… Se publica entre la descripción y la nota, y es la única
   * parte del manual donde el usuario escribe sintaxis de Docusaurus directamente
   * (se sanea con `sanitizeContent`, §10). Ausente si el paso no lleva bloque.
   */
  content?: string
  /**
   * Carpeta de capturas (paso `kind: 'group'`) a la que pertenece este paso.
   *
   * La pertenencia es explícita y no posicional —al revés que en las secciones—
   * porque una carpeta es un bloque cerrado: si dependiera de la posición, el
   * paso siguiente que se grabara entraría dentro sin que nadie lo pidiera. En la
   * lista, los miembros van siempre seguidos y justo detrás de su carpeta; en el
   * manual no se numeran: son las ilustraciones del paso que es la carpeta.
   */
  groupId?: string
  /** metadato: URL en el momento de la interacción */
  url: string
  /** ruta relativa dentro del paquete exportado (`img/paso-03.png`); '' si el paso no lleva imagen */
  screenshot: string
  boundingRect: BoundingRect
  /** false = paso solo de navegación, no se documenta */
  includeInDocs: boolean
  timestamp: string
}

/** Los cinco tipos de «admonition» que Docusaurus renderiza de serie. */
export type AdmonitionType = 'note' | 'tip' | 'info' | 'warning' | 'danger'

/**
 * Nota destacada de un paso. Se publica como un bloque `:::<type>[<title>]` en
 * el MDX; el cuerpo admite el diseño de Docusaurus (negrita, `<mark>`, emojis…).
 */
export interface StepNote {
  type: AdmonitionType
  /** título opcional del recuadro; si falta, Docusaurus usa el del tipo */
  title?: string
  /** cuerpo en Markdown/MDX */
  body: string
}

export interface Viewport {
  width: number
  height: number
}

export interface DocSession {
  id: string
  module: string
  /** subcategoría opcional entre módulo y funcionalidad; ausente = 2 niveles */
  subcategory?: string
  feature: string
  title: string
  /** rol del usuario que ejecuta el flujo */
  role: string
  baseUrl: string
  viewport: Viewport
  createdAt: string
  steps: DocStep[]
}

export interface SessionMeta {
  module: string
  /** subcategoría opcional (nivel intermedio del sidebar de Docusaurus) */
  subcategory: string
  feature: string
  title: string
  role: string
  baseUrl: string
  /**
   * Material de referencia que pega quien documenta —un texto, la tabla de campos
   * de un formulario, un fragmento de código— para que la IA redacte con los
   * nombres y las reglas del sistema real en vez de deducirlos de la captura.
   *
   * Viaja con la sesión (se autoguarda en el borrador) pero NO se publica en el
   * manual: es contexto para redactar, no contenido. Tampoco entra en
   * `session.json`, que es el paquete reproducible.
   */
  aiContext?: string
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 }

/** Estado del motor de grabación, reflejado en el indicador de la barra superior. */
export type RecorderStatus = 'idle' | 'recording' | 'paused'

export interface EngineState {
  status: RecorderStatus
  /** true cuando Playwright está adjunto al viewport vía CDP */
  attached: boolean
  /** URL actual del viewport */
  url: string
  /** último error del motor, si lo hubo */
  error?: string
}

/**
 * Una interacción tal como ocurrió: qué se hizo, sobre qué elemento y con qué
 * valor, sin textos editoriales ni rutas de imágenes. Un paso agrupado guarda
 * varias (`mergedActions`), que es lo que permite señalar a todos sus elementos.
 */
export interface RecordedAction {
  order: number
  action: StepAction
  selectorCandidates: SelectorCandidate[]
  value?: string
  url: string
}

export interface SaveResult {
  /** carpeta final: <root>/<module>/<feature> */
  path: string
  stepsWritten: number
  imagesWritten: number
  /** presente solo si se pidió registrar el resultado en Git */
  git?: GitCommitResult
  /** el commit se pidió pero falló; el paquete en disco sí se escribió */
  gitError?: string
  /**
   * Comprobación del sitio antes de commitear (§17). Si falló, el commit NO se
   * hizo: el paquete está en disco y se puede corregir y volver a guardar.
   */
  checks?: ChecksResult
}

/* --- Comprobación del sitio de destino (§17) --- */

/** Un comando del proyecto de destino que sabemos interpretar. */
export interface DocCheck {
  /** nombre del script en su `package.json` */
  script: string
  /** cómo se nombra en la GUI */
  label: string
  /** qué comprueba, en una línea */
  detail: string
}

/**
 * La guía de estilo del repositorio de documentación (§20).
 *
 * Es el documento que explica cómo hay que escribir en ESE proyecto —lo que
 * `lint:docs` comprueba después—, y hasta ahora vivía fuera de la aplicación:
 * quien documentaba se enteraba de sus reglas cuando el comando fallaba, con la
 * guía ya escrita y el commit bloqueado.
 */
export interface ProjectGuide {
  /** ruta del archivo, para poder abrirlo en el editor */
  path: string
  /** su contenido en Markdown */
  content: string
  /** se cortó por ser enorme: se dice, en vez de enseñar media regla */
  truncated?: boolean
}

/** Qué se puede ejecutar en el proyecto que contiene la carpeta de salida. */
export interface ProjectChecks {
  /** raíz del proyecto Docusaurus: donde están `package.json` y la configuración */
  projectRoot: string
  /** los comandos conocidos que ese proyecto tiene, en orden de ejecución */
  checks: DocCheck[]
  /** tiene `build` y `serve`: se puede levantar la vista previa compilada */
  canServe: boolean
}

export interface CheckRun {
  script: string
  label: string
  ok: boolean
  /** lo que tardó, para poder decir por qué guardar tardó tanto */
  ms: number
  /** últimas líneas de su salida (ahí está el error) */
  output: string
  /**
   * Archivos que cita el error, repartidos según de quién son. Los comandos del
   * proyecto miran TODA la documentación, así que un fallo puede no tener nada
   * que ver con lo que se acaba de guardar: saber eso es la diferencia entre
   * corregir algo propio y registrar con confianza y arreglar lo ajeno aparte.
   * Solo se rellenan cuando el comando falla y se sabe qué guía se estaba
   * guardando; las rutas son relativas a la raíz del proyecto.
   */
  ownFiles?: string[]
  otherFiles?: string[]
}

export interface ChecksResult {
  projectRoot: string
  /** todo pasó; con `false` no se ha commiteado nada */
  ok: boolean
  runs: CheckRun[]
  /** lo paró el usuario: no es un fallo del sitio */
  canceled?: boolean
}

/** Progreso de la tanda, un comando (y una línea de su salida) a la vez. */
export interface CheckProgress {
  script: string
  label: string
  index: number
  total: number
  /** una línea recién escrita por el comando; ausente al empezar cada uno */
  line?: string
}

/** Resultado de levantar la vista previa compilada. */
export interface PreviewResult {
  /** dirección servida, ya abierta en el navegador */
  url?: string
  /** no se pudo ni intentar (sin proyecto, sin `serve`, el servidor no respondió) */
  error?: string
  /** el `build` previo falló: aquí está el motivo */
  checks?: ChecksResult
}

export interface PreviewStatus {
  running: boolean
  url?: string
}

/**
 * Estado del repositorio que contiene la carpeta de salida (§ fase Git).
 * `null` cuando esa carpeta no está dentro de ningún repositorio.
 */
export interface GitRepoInfo {
  root: string
  /** rama actualmente activa */
  branch: string
  /** un repositorio recién creado aún no tiene HEAD resoluble */
  hasCommits: boolean
  remoteUrl: string | null
  /** rutas con cambios ya en el índice */
  stagedPaths: string[]
  /** rutas seguidas y modificadas en el árbol de trabajo */
  dirtyPaths: string[]
  /** rutas sin seguimiento (no impiden cambiar de rama) */
  untrackedPaths: string[]
  /**
   * Rama de la que nacen las ramas de documentación (`main` habitualmente), o
   * `null` si el repositorio no declara ninguna reconocible.
   */
  defaultBranch: string | null
}

/** Una rama local, para el explorador de repositorios (solo lectura). */
export interface GitBranchInfo {
  name: string
  /** rama activa en el árbol de trabajo */
  current: boolean
  /** resumen del último commit, para situar la rama de un vistazo */
  lastCommitSubject: string
  lastCommitDate: string
  /** commits que tiene por delante de la rama por defecto */
  aheadOfDefault: number
}

/**
 * Una funcionalidad ya documentada en una rama, leída de su `session.json`
 * commiteado.
 *
 * Es lo que permite retomar una rama sin volver a escribir los metadatos: la
 * fuente de verdad es el repositorio, no un registro local, así que también
 * funciona con lo que documentó otra persona (u otra máquina).
 */
export interface BranchDocInfo {
  /** ruta del session.json dentro del repo, p. ej. `administracion/pie/session.json` */
  path: string
  module: string
  /** subcategoría con la que se documentó, o '' si no tiene */
  subcategory: string
  feature: string
  title: string
  role: string
  baseUrl: string
  /** ISO de creación de la sesión, para situarla en el tiempo */
  createdAt: string
}

/**
 * Un paquete de documentación que está **escrito en el repositorio pero no
 * registrado en Git**: o Git no lo conoce todavía (carpeta nueva sin commitear),
 * o alguno de sus archivos cambió después del último commit.
 *
 * Existe porque el paquete en disco y el commit son dos pasos separados a
 * propósito (§7: si el commit falla, la grabación no se pierde). Sin esta lectura,
 * una grabación guardada sin llegar a comitear —porque falló el commit, porque se
 * cerró la app, o porque se guardó sin activar Git— quedaba invisible para la
 * aplicación aunque estuviera entera en el disco.
 */
export interface PendingDocInfo extends BranchDocInfo {
  /** ruta de la carpeta del paquete dentro del repo (la que contiene session.json) */
  dir: string
  /** rutas del paquete que Git no tiene al día, relativas a la raíz del repo */
  pendingFiles: string[]
  /** pasos que trae el `session.json` leído del disco */
  steps: number
  /** true si Git no conoce el `session.json` todavía (paquete nunca commiteado) */
  untracked: boolean
}

/**
 * Resultado de descartar un paquete sin registrar.
 *
 * Se distingue lo que se tiró de lo que se revirtió porque son dos cosas
 * distintas para quien lo lee: los archivos nuevos van a la **papelera del
 * sistema** (recuperables desde el propio escritorio) y los que ya estaban
 * commiteados vuelven a su versión del último commit, sin salir del repositorio.
 */
export interface DiscardResult {
  /** archivos (o carpetas) que se movieron a la papelera */
  trashed: number
  /** archivos seguidos que se devolvieron a su versión commiteada */
  restored: number
  /** resumen legible para mostrar en la GUI */
  message: string
}

/** Un commit del historial de una rama (solo lectura). */
export interface GitCommitInfo {
  hash: string
  subject: string
  author: string
  date: string
}

/** Documentación (una funcionalidad) registrada en un commit, para previsualizar. */
export interface CommitDocs {
  /** ruta del session.json en el repo, p. ej. `matriculas/crear/session.json` */
  path: string
  session: DocSession
}

/* ---------- asistencia de IA para redactar los pasos (§11) ---------- */

/** Proveedores admitidos para redactar títulos y descripciones. */
export type AiProvider = 'anthropic' | 'gemini'

export interface AiSettings {
  /** proveedor que se usa al redactar */
  provider: AiProvider
  /** modelo elegido para cada proveedor; se recuerda uno por proveedor */
  models: Record<AiProvider, string>
  /**
   * Enviar también la captura del paso. Con ella el modelo ve la pantalla real y
   * sitúa el paso («en la pestaña Datos personales»); sin ella solo recibe la
   * acción, el elemento y el valor, que es bastante más barato.
   */
  useScreenshot: boolean
}

/**
 * Lo que la GUI puede saber de la configuración de IA. Las claves nunca salen
 * del proceso principal: aquí solo viaja si hay o no hay clave.
 */
export interface AiStatus {
  settings: AiSettings
  /** proveedores con clave guardada */
  configured: Record<AiProvider, boolean>
  /** el proveedor activo tiene clave: se puede redactar */
  ready: boolean
  /** las claves se guardan cifradas por el sistema operativo */
  encrypted: boolean
}

/** Redacción propuesta para un paso. */
export interface AiStepDraft {
  id: string
  title: string
  description: string
}

export interface AiDraftResult {
  drafts: AiStepDraft[]
  /**
   * Motivo por el que no se pudo completar. Puede venir junto a `drafts`: si
   * falla a mitad, lo ya redactado se aprovecha en vez de perderse.
   */
  error?: string
}

/**
 * Modelos ofrecidos por proveedor. Todos aceptan imágenes y salida estructurada,
 * que es lo que necesita la redacción; el primero de cada lista es el de partida.
 */
export const AI_MODELS: Record<AiProvider, string[]> = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-5'],
  gemini: ['gemini-3.5-flash', 'gemini-2.5-flash']
}

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: 'Claude (Anthropic)',
  gemini: 'Gemini (Google)'
}

export const AI_PROVIDERS: AiProvider[] = ['anthropic', 'gemini']

/**
 * Comprueba que lo que se guarda como clave pueda serlo, y devuelve el motivo si
 * no. Las claves de ambos proveedores son una sola palabra de ASCII imprimible y
 * de poco más de cien caracteres; cualquier otra cosa es un pegado equivocado.
 *
 * Merece una comprobación propia porque el campo está enmascarado: un pegado
 * accidental no se ve, y la clave acaba en una cabecera HTTP, donde un carácter
 * fuera de ASCII revienta la petición con un error ilegible («Cannot convert
 * argument to a ByteString…») en vez de decir que la clave está mal.
 */
export function apiKeyProblem(key: string): string | null {
  if (!key) return null
  if (key.length > 300) {
    return 'Eso no parece una clave: tiene demasiados caracteres. Copia solo la clave del proveedor.'
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    return 'Eso no parece una clave: lleva espacios, saltos de línea o caracteres (acentos, emojis) que una clave no tiene.'
  }
  return null
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'anthropic',
  models: { anthropic: AI_MODELS.anthropic[0], gemini: AI_MODELS.gemini[0] },
  useScreenshot: true
}

export interface GitCommitOptions {
  repoRoot: string
  branch: string
  message: string
  /** rutas absolutas de los archivos escritos por DocRecorder */
  files: string[]
  push: boolean
  /**
   * Rama desde la que crear la rama nueva. Si se omite, se usa la rama por
   * defecto del repositorio: cada documentación debe abrir su propio PR, no
   * encadenarse sobre la anterior.
   */
  baseBranch?: string
}

export interface GitCommitResult {
  repoRoot: string
  branch: string
  createdBranch: boolean
  /** hash corto, o null si no había nada que registrar */
  commit: string | null
  committedFiles: number
  pushed: boolean
  /** resumen legible para mostrar en la GUI */
  message: string
}

/** Lo que la GUI envía al guardar cuando el usuario activa la integración Git. */
export interface GitSaveOptions {
  enabled: boolean
  branch: string
  message: string
  push: boolean
  /** elegida en el explorador de repositorios; sin ella se usa la por defecto */
  baseBranch?: string
  /**
   * Comprobar el sitio antes de commitear (§17). Con `false` se comitea sin
   * ejecutar nada: es lo que hace «Registrar de todos modos» tras un fallo.
   */
  verify?: boolean
  /**
   * Comandos que el usuario ha desmarcado para este proyecto (§20): se conocen,
   * pero no se ejecutan. Compilar el sitio entero tarda minutos y no siempre
   * hace falta pagarlos en cada guardado; el resto sí, y saltárselos todos —lo
   * único que se podía hacer antes— dejaba de comprobar también lo barato.
   */
  skipChecks?: string[]
}

/**
 * Repositorio de documentación que el usuario ya ha usado.
 *
 * El registro solo recuerda carpetas locales: la app no clona ni crea nada en
 * GitHub. Sirve para volver a un repositorio sin tener que buscarlo otra vez en
 * el disco.
 */
export interface ProjectEntry {
  /** raíz del repositorio */
  root: string
  /** nombre mostrado: la carpeta raíz */
  label: string
  /** ISO; ordena la lista por uso más reciente */
  lastUsedAt: string
  /** última carpeta de salida usada dentro de ese repositorio */
  lastOutputDir: string
  /** el repositorio puede haberse movido o borrado desde la última vez */
  missing?: boolean
}
