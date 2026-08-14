# Especificación técnica — MVP Grabador de Documentación ("DocRecorder")

## 1. Contexto y objetivo

Herramienta de escritorio para documentar paso a paso los módulos de un sistema web (frontend en **Next.js**, al cual NO se tiene acceso de código fuente — solo acceso como usuario vía navegador). La documentación final vivirá en un proyecto **Docusaurus** mantenido por otro desarrollador.

**Flujo de trabajo esperado:** el repositorio Docusaurus ya existe y lo mantiene esa otra persona. Quien documenta **clona** ese repositorio en su máquina y, en la app, elige como **carpeta de salida** una carpeta situada dentro de ese clon. La app nunca crea ni clona repositorios: solo detecta el que ya contiene la carpeta elegida (ver §10).

**Objetivo del MVP (esta etapa):** una app Electron donde el usuario:

1. Abre el sistema web en un viewport embebido.
2. Presiona "Grabar" y navega normalmente.
3. Cada interacción relevante genera automáticamente una **tarjeta de paso** en un panel lateral: captura de pantalla con el elemento resaltado + selector detectado + campo editable de título/descripción.
4. Puede editar, reordenar y eliminar pasos.
5. Al guardar, exporta un paquete portable a disco: `steps.json` + capturas PNG + un `flow.json` reproducible.

**Ya implementado tras el MVP:**

- **Integración Git** (ramas, commits, explorador de repositorios). Se planificó como fuera de alcance, pero está construida; ver §10.
- **Generación de MDX para Docusaurus**. Cada grabación produce, además del paquete JSON, la página del manual en `.mdx` (con su categoría de módulo) que Docusaurus renderiza directamente; ver §7 y §10.
- **Runner de regeneración**. Re-ejecuta el `flow.json` de una funcionalidad en el visor autenticado y actualiza sus capturas cuando el sistema documentado cambia de interfaz; ver §12.
- **Asistencia de IA para redactar los pasos**. Propone título y descripción de cada paso a partir de la acción grabada y de su captura; ver §14. Con esto se completa la lista de «fuera de alcance» del planteamiento inicial.

## 2. Stack técnico

- **Electron** (última estable) con **electron-vite** como tooling.
- **React 18 + TypeScript** en el renderer (GUI).
- **`WebContentsView`** de Electron para el viewport embebido (NO iframe, NO `<webview>` tag deprecado).
- **Playwright** (`playwright-core`) conectado al viewport vía **CDP**: Electron se lanza con `--remote-debugging-port`, y un módulo "motor" usa `chromium.connectOverCDP()` para adjuntarse al `WebContentsView` del sistema web. Playwright se usa desde ya para observar el DOM y generar selectores, de modo que en la etapa 3 (runner) los mismos selectores sean reproducibles sin conversión.
- **zustand** (o similar ligero) para estado del panel de pasos.
- Persistencia simple en disco (JSON + PNG). Sin base de datos.
- **SDK de cada proveedor de IA** para la redacción de los pasos (§14): `@anthropic-ai/sdk` (Claude) y `@google/genai` (Gemini). Ambos se usan **solo desde el proceso principal**.

## 3. Arquitectura de procesos

```
┌───────────────────────────────────────────────────────┐
│ Electron Main                                          │
│  - Crea BrowserWindow (GUI React) + WebContentsView    │
│    (viewport del sistema web, ~70% del ancho)          │
│  - Módulo Recorder Engine (Node):                      │
│      · conexión CDP → Playwright page del viewport     │
│      · inyección del script observador                 │
│      · captura de pantalla + generación de selectores  │
│  - IPC hub entre GUI y engine                          │
└───────────────────────────────────────────────────────┘
        ▲ IPC (contextBridge, canales tipados)
        ▼
┌───────────────────────┐
│ Renderer (React GUI)  │
│  - Barra de sesión    │
│  - Panel de pasos     │
│  - Controles ● ⏸ ■    │
└───────────────────────┘
```

### Captura de interacciones (diseño requerido)

- El engine inyecta en el viewport (vía `page.addInitScript` + `page.exposeBinding`) un observador que escucha en fase de captura: `click`, `change` (inputs/selects), `submit` y `keydown` de Enter.
- Al detectar un evento, el observador envía al engine: coordenadas, `boundingRect` del target, snapshot de atributos del elemento (tag, id, `data-testid`, `aria-*`, `role`, `name`, `placeholder`, texto visible recortado a 80 chars) y la cadena de ancestros relevante.
- El engine entonces:
  1. Espera estabilidad del DOM tras el efecto del clic (ver §5 sobre Next.js).
  2. Genera los selectores candidatos (ver §4).
  3. Dibuja el **highlight** inyectando un overlay absoluto (borde 3px `#FF5722`, radio 6px) sobre el `boundingRect`. Si algo ha quedado **por encima** del elemento (`coverOf`, vía `elementFromPoint`) el recuadro puede añadir `backdrop-filter: brightness()`, que le devuelve el brillo solo en esa zona: si no, el paso señalaría un elemento apagado justo cuando pide mirarlo. Pero «por encima» no es una sola cosa, y tratarlas igual fue un fallo real: se clasifica por el **alfa acumulado** de lo que tapa. `translucent` (velo de un modal) → se compensa. `opaque` (un desplegable abierto sobre el formulario, un menú) → **no** se compensa: aclarar lo que hay bajo un panel opaco no devuelve nada a la vista y quema lo que sí se ve —con brillo 1.9 todo lo más claro que `#868686` acaba en blanco puro, así que los bordes y el texto gris de los campos desaparecían: eran los campos «borrosos» del grupo—. `none` (nada, o una capa **sin fondo**, como el `<fieldset>` decorativo con el que las librerías dibujan el borde de un campo) → tampoco: ese adorno se lleva el `elementFromPoint` y no oscurece absolutamente nada. **Sin número**: el orden de los pasos cambia al eliminar o reordenar, y un número pintado en el PNG no se puede rehacer —son píxeles—, así que acabaría contradiciendo al paso que ilustra. El número lo ponen quienes sí pueden mantenerlo al día: la tarjeta del panel y el encabezado del MDX.
  4. Toma la captura (`page.screenshot`, viewport completo, PNG).
  - **Clics que navegan** (cerrar sesión, un enlace): la captura se toma tras esperar estabilidad, pero para entonces la página es otra y el elemento a señalar ya no existe; el paso ilustraba la pantalla siguiente y sin recuadro. Medido: una vez arrancada la navegación, **Chromium aplaza la ejecución de scripts** (`Runtime.evaluate` tardaba ~900 ms y respondía ya sobre la página nueva), así que el resaltado no puede dibujarse desde el motor. Por eso el **observador lo dibuja de forma síncrona** al recibir el clic, antes de la acción por defecto, y el motor solo captura —eso sí llega mientras la página anterior siga a la vista—. Esa captura previa se usa únicamente si al estabilizar ya no se puede señalar el elemento. La captura previa usa **CDP en crudo** y no la API de Playwright, que espera a que termine toda navegación pendiente.
  - **Elementos que se desvanecen** (menús, popovers, diálogos de las librerías actuales): al elegir una opción, el menú no se desmonta —baja su opacidad durante unos cientos de milisegundos y se quita después—, y la captura definitiva cae justo en esa ventana: el paso ilustraba un menú medio borrado. El observador informa al motor de si el elemento señalado está **desvaneciéndose** (`HighlightResult.faded`: opacidad efectiva acumulando ancestros < 0.6, o `visibility`/`display` ya apagados) y, si lo está, se usa la captura previa al clic, la misma pieza que resuelve los clics que navegan.
  5. Remueve el overlay.
  6. Emite el paso a la GUI por IPC.
- **Gestos que empiezan en `pointerdown`.** Escuchar solo `click` deja fuera un patrón hoy omnipresente: el menú se abre en `pointerdown` y monta encima una capa de descarte, así que el `pointerup` cae en esa capa y el navegador dispara el `click` sobre el ancestro común —`<body>` normalmente— o no lo dispara. El botón que se pulsó (el «Ver» de una tabla) no generaba paso, o generaba uno inservible sobre `<body>`. El observador anota el control donde empieza el gesto y: si el `click` llega sobre algo no interactivo, lo atribuye a ese control; si no llega en `CLICK_FALLBACK_MS`, documenta el gesto igualmente. Solo para controles (`INTERACTIVE`), nunca para texto o fondo, y no para elementos arrastrables: soltar fuera no es haber pulsado.
- Inputs de texto: consolidar en UN paso por campo (valor final), no un paso por tecla. Los campos de contraseña registran la acción pero guardan el valor como `"***"`.
- **Agrupar seguidos** (interruptor en el panel, preferencia persistida, por defecto activo): la GUI funde en un solo paso los controles **seguidos del mismo tipo**, con una sola captura y la lista de lo fundido en `DocStep.fields`. Reduce drásticamente las imágenes: un formulario de N campos pasa de N pasos a uno. La fusión es una decisión de la GUI (`store.addStep`), no del motor, que sigue emitiendo un evento por interacción.
  - **Por familia** (`StepFamily`, la calcula el motor porque hace falta el DOM): `field` (se da un valor — escribir, elegir en un desplegable o una lista, marcar una casilla, un radio o un interruptor, y elegir la opción de un desplegable abierto), `tab` (`[role=tab]`) y `action` (botones, enlaces, `<summary>`, opciones de menú). Un envío, una tecla y una navegación **no tienen familia**: nunca se funden. La regla anterior era binaria (campo / no campo) y dejaba sueltos dos casos de cualquier sistema real: recorrer dos pestañas, y abrir un menú y elegir su opción, que son **un** paso para quien lee.
  - **Cambiar de familia abre paso nuevo.** Es lo que conserva el corte natural del flujo: el «Guardar» de un formulario sigue teniendo tarjeta propia y se le une a mano si procede (decisión explícita del usuario, 2026-07).
  - **Ni a través de una recarga:** cada carga de página trae un `loadRef` nuevo (el observador se instala en un contexto nuevo). Sin eso, pulsar un botón, recargar y volver a pulsar se fundía en un paso porque la URL coincidía.
  - **Qué cuenta como campo:** no basta la etiqueta HTML. Se reconoce por tres vías, en este orden: el elemento **es** un control (`input`/`select`/`textarea` o un **rol ARIA** de campo — `FIELD_ROLES` en `recorder.ts`); es una **`<label>`** que acciona uno; o es el **envoltorio** de un control estilizado, que el observador detecta subiendo unos pocos niveles hasta un contenedor con **exactamente un** control (`fieldWrapperOf`). Ese último caso es el de los interruptores actuales, donde el `<input>` real está escondido y lo que se pulsa es un `<span>` **hermano** suyo. Un `button`, `a` o `[role=tab]` nunca cuenta como campo aunque esté junto a uno: debe cerrar el grupo.
  - **Un gesto, un paso:** un solo clic puede generar varios eventos —el navegador reenvía el clic de una `<label>` a su control, y un interruptor acciona por código el `<input>` que esconde—. El observador descarta los reenvíos: mismo gesto si llegan dentro de `SAME_GESTURE_MS` y, además, uno contiene al otro, comparten envoltorio de campo, o el segundo no es de confianza (`isTrusted`). Se documenta el primero, que es el visible y el que da mejor selector.
  - **Resaltado del grupo:** la captura de un paso agrupado marca **todos** sus campos, no solo el último. Al fundir, la GUI pide al motor una captura nueva (`recorder:capture-group`) con un recuadro por campo. Por eso el observador conserva las referencias a los elementos en vez de liberarlas al capturar, y recalcula los rectángulos en el momento de la captura (la página puede haber rodado).
  - **Cuando la referencia ya no vale:** los frameworks actuales **reemplazan el nodo** al re-renderizar (guardar un formulario, redibujar una tabla). El campo sigue en la pantalla, pero es otro elemento y la referencia guardada apunta al viejo: el recuadro no aparecía. Cada elemento del grupo viaja ahora como `GroupTarget` —sus referencias **y** sus `selectorCandidates`—, y el motor localiza por selector (con `page.locator`, como el runner) los que ya no resuelven por referencia. Es lo que hace que se pueda agrupar a mano el formulario con el botón que lo cierra.
  - **Cuando lo marcado no se vería:** el observador devuelve, además de cuántos elementos marcó, cuántos están **tapados por algo opaco** (`blocked`), cuántos se están **desvaneciendo** (`fading`) y cuántos **ya no están** (`missing`). Tapado → limpiar, esperar ~350 ms y repetir una vez; si sigue tapado, se captura igual con los recuadros. Desvaneciéndose o ausente → **no se captura**: se conserva la imagen que el paso ya tiene, que es la única donde ese elemento se ve. Es lo que pasa al fundir «abrir el menú» con «elegir su opción»: cuando la GUI pide la captura del grupo, el menú ya se cerró, y la buena es la del clic.
  - **Nunca pisar una captura buena:** si la pantalla ya no es la del paso (`url` distinta), no se captura nada y el paso conserva su imagen. Antes se sustituía por una de la pantalla siguiente, que era peor que no rehacerla.
  - **Dentro de una tabla manda dónde está el control.** El observador sitúa cada elemento en la rejilla (`tableRef`, `rowRef`, `cellRef`, `colIndex` y el `colHeader` de su columna; identidades por `WeakMap`) y la GUI funde solo lo que significa algo en un manual: la **misma celda** y la **misma fila** (un registro que se edita en línea) y la **misma columna** en varias filas (la misma acción repetida sobre varios registros: marcar la casilla de cinco alumnos es un paso, no cinco). Lo que **no** se funde es lo que de verdad no tiene que ver: dos controles distintos de filas distintas, dos tablas distintas y una tabla con lo de fuera. El ámbito se comprueba contra **todos** los miembros del grupo, no solo el último, o un grupo de columna se «arrastraría» fuera de su columna paso a paso.
  - **Título por lo que es, no por un recuento:** «Rellenar el formulario», «Rellenar la fila», «Marcar «Estado» en 3 filas» (con el encabezado de la columna), «Ir a las pestañas «A» y «B»», «Pulsar «Guardar» y «Cerrar»». Se recalcula al fundir cada paso nuevo **solo mientras siga siendo el que generó la app**: si quien documenta ya escribió el suyo —el panel enfoca el título de cada paso nuevo, así que es lo normal—, el campo siguiente no se lo pisa. Y el MDX no repite en una lista lo que el título ya enumera.
  - **Deshacer también lo automático:** la fusión automática conserva los pasos originales en `groupSources`, igual que la manual, así que ⊟ devuelve cada uno con su captura sin tener que apagar el interruptor y volver a grabar.
  - **Fuente de verdad:** en la GUI el grupo vive en `RecordedStep.groupItems` (etiqueta, valor, acciones y referencias por campo). De ahí se derivan `fields` y `mergedActions`, de modo que **quitar un campo** de la tarjeta se lleva también su acción del `flow.json` y su resaltado. No se permite vaciar el grupo: para eso está eliminar el paso.
- **Agrupar a mano cualquier cosa** (selección múltiple en el panel). La agrupación automática solo puede unir lo que *sabe* que es un formulario, y hay muchos pasos que son UNO para quien lee y que ninguna heurística puede adivinar: dos botones, un selector con su opción, varias filas de una tabla, o una mezcla. El usuario marca la casilla de las tarjetas y pulsa **⊞ Agrupar**; el resultado es exactamente el mismo tipo de paso agrupado (mismos `groupItems`/`fields`/`mergedActions`), así que el resto de la app no distingue su origen.
  - **Etiqueta de cada elemento:** el nombre del campo si es un campo (así se lee un formulario), y el **título completo** del paso si no lo es («Clic en «Guardar»»), porque ahí el verbo es parte de la información.
  - **Título del grupo:** el caso frecuente no es agrupar cinco cosas cualesquiera, es **un formulario y la acción que lo cierra** —el motor deja el botón aparte porque es otra familia—. Ese grupo se titula «Rellenar el formulario y pulsar «Guardar»», no «… y 1 más»: el recuento no dice nada en el manual. Se conserva el recuento solo para las mezclas que no encajan en ningún patrón.
  - **Solo pasos seguidos:** el grupo se reproduce como una secuencia; fundir el paso 2 con el 7 reordenaría el flujo real y el runner ejecutaría un orden que nunca ocurrió. La barra de selección **explica el motivo** cuando el botón no está disponible, en vez de quedarse apagada sin más. Tampoco se agrupan capturas externas ni bloques de contenido (§15): no son acciones.
  - **Deshacer:** el paso agrupado guarda los originales en `groupSources` (y el borrador copia también **sus** capturas), así que ⊟ devuelve cada paso con su propia imagen en vez de dejar pasos huérfanos compartiendo la del grupo. Quitar un elemento del grupo a mano retira esa posibilidad: restaurar lo que se acaba de quitar sería lo contrario de lo que se pidió.
  - **Captura:** al agrupar se rehace la captura señalando **todos** los elementos (`recorder:capture-group`, la misma pieza que la agrupación automática), incluidos los que el framework haya re-renderizado por el camino. Si la página ya cambió de pantalla, se conserva la que el paso traía.

## 4. Estrategia de selectores (crítica — el frontend es Next.js)

El frontend usa Next.js: las clases CSS pueden ser hasheadas (CSS Modules) o utilitarias (Tailwind). **Prohibido** basar selectores en clases con hash o cadenas largas de utilidades.

Por cada paso, generar una lista ordenada de `selectorCandidates` (mínimo 2 cuando sea posible):

1. `[data-testid="..."]` si existe.
2. `id` si existe y no parece autogenerado (rechazar ids tipo `:r1:`, `radix-...`, uuid).
3. **Rol ARIA + nombre accesible** → serializado como `role=button[name="Nueva matrícula"]` (formato compatible con `page.getByRole`).
4. Texto visible exacto → `text="Nueva matrícula"` (compatible con `page.getByText`).
5. CSS estructural corto como último recurso (máx. 3 niveles, sin clases hasheadas).

Guardar TODOS los candidatos en el paso; el primero es el preferido. Esto permite que el runner futuro haga fallback automático.

## 5. Consideraciones específicas por Next.js

- **Hidratación**: no capturar en el instante del evento; esperar `networkidle` con timeout corto (1.5 s) O estabilidad de layout (dos lecturas de `document.body` sin mutaciones en 300 ms vía MutationObserver), lo que ocurra primero.
- **App Router / navegación cliente**: los cambios de vista no siempre cambian la URL ni recargan. Delimitar pasos por interacción del usuario, nunca por eventos de navegación. Registrar la URL en cada paso solo como metadato.
- **Portales/overlays** (modales Radix/Headless UI): el observador debe resolver el target real aunque esté dentro de un portal fuera del árbol principal.

## 6. Modelo de datos

```typescript
interface DocSession {
  id: string // uuid
  module: string // "matriculas"
  subcategory?: string // opcional: nivel intermedio del sidebar ("institucion")
  feature: string // "crear-matricula"
  title: string // "Crear una matrícula"
  role: string // rol del usuario que ejecuta el flujo
  baseUrl: string
  viewport: { width: number; height: number } // fijo, default 1440x900
  createdAt: string // ISO
  steps: DocStep[]
}

interface DocStep {
  id: string
  order: number
  action: 'click' | 'fill' | 'select' | 'submit' | 'press' | 'navigate' | 'capture' | 'image' | 'content' | 'section' | 'group'
  kind?: 'interaction' | 'capture' | 'image' | 'content' | 'section' | 'group' // ausente = interaction (lo grabó el motor)
  groupId?: string // carpeta de capturas a la que pertenece este paso (§17)
  title: string // editable por el usuario
  description: string // editable por el usuario
  selectorCandidates: SelectorCandidate[]
  value?: string // para fill/select ("***" si es password)
  fields?: { label: string; value: string }[] // lo agrupado en el paso (§3): campos de un formulario o acciones unidas a mano
  mergedActions?: FlowAction[] // acciones individuales del paso agrupado, para que el runner lo reproduzca (§12)
  note?: { // nota destacada → admonition de Docusaurus (§10)
    type: 'note' | 'tip' | 'info' | 'warning' | 'danger'
    title?: string
    body: string // Markdown/MDX
  }
  content?: string // bloque de contenido en Markdown/MDX: tabla, código, pestañas… (§10)
  url: string // metadato
  screenshot: string // ruta relativa: img/paso-03.png; '' si el paso no lleva imagen
  boundingRect: { x: number; y: number; width: number; height: number }
  includeInDocs: boolean // false = paso solo de navegación
  timestamp: string
}

interface SelectorCandidate {
  strategy: 'testid' | 'id' | 'role' | 'text' | 'css'
  value: string
  score: number // 0-100, robustez estimada
}
```

**Paso en vuelo** (`RecordedStep`, en `src/shared/ipc-contract.ts`): lo que viaja del motor a la GUI. Extiende `DocStep` con campos que **no se persisten**, porque solo valen mientras la página siga cargada:

```typescript
interface RecordedStep extends DocStep {
  tempFile: string // ruta absoluta del PNG temporal; al guardar se copia a img/paso-NN.png
  isFormField?: boolean // el elemento es (o acciona) un campo: decide la agrupación (§3)
  ref?: number // referencia al elemento en el observador, para volver a resaltarlo
  rowRef?: number | null // fila de tabla que lo contiene: dos filas nunca se funden solas
  groupItems?: GroupedField[] // fuente de verdad del paso agrupado (§3)
  groupSources?: RecordedStep[] // los pasos previos a una agrupación manual, para poder deshacerla
}

// Un campo dentro de un paso agrupado. De aquí se derivan `fields` (lo que se
// publica) y `mergedActions` (lo que reproduce el runner), de modo que quitar un
// campo no deje descuadrada ni su acción ni su resaltado.
interface GroupedField {
  label: string
  value: string // vacío si solo se enfocó
  actions: FlowAction[] // enfocar y escribir son dos
  refs: number[] // sus elementos, para volver a marcarlos en la captura
}
```

**Tipos de la asistencia de IA** (§14), en `src/shared/types.ts`. La clave **nunca** viaja al renderer: solo si existe o no.

```typescript
type AiProvider = 'anthropic' | 'gemini'

interface AiSettings {
  provider: AiProvider
  models: Record<AiProvider, string> // se recuerda un modelo por proveedor
  useScreenshot: boolean // enviar también la captura del paso (visión)
}

interface AiStatus {
  settings: AiSettings
  configured: Record<AiProvider, boolean> // proveedores con clave guardada
  ready: boolean // el proveedor activo tiene clave
  encrypted: boolean // el sistema operativo ofrece cifrado para guardarla
}

interface AiStepDraft {
  id: string // el del paso; solo se aceptan los que se pidieron
  title: string
  description: string
}
```

**Tipos de la integración Git** (ver §10). Todos viven en `src/shared/types.ts`:

```typescript
// Estado del repositorio que contiene la carpeta de salida; null si no hay.
interface GitRepoInfo {
  root: string
  branch: string // rama activa
  hasCommits: boolean // un repo recién inicializado aún no tiene HEAD
  remoteUrl: string | null
  stagedPaths: string[] // cambios ya en el índice
  dirtyPaths: string[] // seguidos y modificados en el árbol de trabajo
  untrackedPaths: string[] // sin seguimiento (no impiden cambiar de rama)
  defaultBranch: string | null // rama de la que nacen las de documentación
}

// Lo que la GUI envía al guardar cuando activa el registro en Git.
interface GitSaveOptions {
  enabled: boolean
  branch: string
  message: string
  push: boolean
  baseBranch?: string // elegida en el explorador; sin ella, la por defecto
}

// Solo lectura, para el explorador de repositorios.
interface GitBranchInfo {
  name: string
  current: boolean
  lastCommitSubject: string
  lastCommitDate: string
  aheadOfDefault: number // commits por delante de la rama por defecto
}

interface GitCommitInfo {
  hash: string
  subject: string
  author: string
  date: string
}

// Registro de repositorios ya usados (userData/projects.json, ver §7).
interface ProjectEntry {
  root: string
  label: string // la carpeta raíz
  lastUsedAt: string // ISO; ordena la lista por uso más reciente
  lastOutputDir: string
  missing?: boolean // la carpeta se movió o borró desde la última vez
}
```

## 7. Estructura de salida en disco

```
<carpeta-elegida>/          # idealmente la carpeta docs/ del proyecto Docusaurus
└── <module>/
    ├── _category_.json      # etiqueta del módulo en la barra lateral (solo si falta)
    └── [<subcategory>/]     # opcional (§8): nivel intermedio, con su propio _category_.json
        └── <feature>/
            ├── index.mdx    # página del manual que renderiza Docusaurus (§10)
            ├── session.json # DocSession completa
            ├── flow.json    # solo acciones + selectores (insumo del runner futuro)
            └── img/
                ├── paso-01.png
                ├── paso-02.png
                └── ...
```

Nomenclatura: kebab-case en carpetas, `paso-NN.png` con cero a la izquierda. Al reordenar pasos en la GUI, renombrar las imágenes al guardar para que el orden en disco siempre coincida. Los `.json` conviven con el `.mdx` sin estorbar: Docusaurus solo procesa `.md`/`.mdx` y `_category_.json`.

**Registro de proyectos.** La lista de repositorios ya usados se guarda **fuera** del paquete de documentación, en `app.getPath('userData')/projects.json`: es una preferencia de la máquina, no del repositorio, y escribir estado dentro de un repositorio ajeno sería justo lo que las salvaguardas de §10 evitan. La escritura es atómica (archivo temporal + `rename`) para que un cierre a medias no lo corrompa.

## 8. GUI (renderer)

Layout: viewport a la izquierda (flexible, ~70%), panel derecho fijo (mín. 440px).

**Barra superior de sesión:** campos módulo/**subcategoría (opcional)**/funcionalidad/título/rol, URL base + botón "Abrir", selector de carpeta de salida, botón "Proyectos…" (explorador de repositorios), "Regenerar…" (runner, §12), "IA" (ajustes de redacción, §14; muestra ✓ cuando hay clave), interruptor de tema y ayuda, e indicador de estado (Listo / Grabando / Pausado).

**Subcategoría (opcional):** un nivel intermedio entre módulo y funcionalidad, para reproducir la anidación del sidebar de Docusaurus (p. ej. `administracion` → `institucion` → `registrar-institucion`). Vacía ⇒ estructura de dos niveles de siempre (retrocompatible). No es obligatoria para guardar. Al **elegir la rama de trabajo**, el selector muestra en **árbol** las categorías y subcategorías ya documentadas en ella (leídas del git, `git:branch-docs`); pulsar «＋ proceso» en una categoría/subcategoría deja la barra lista para grabar un proceso nuevo ahí (`pickCategory`), y pulsar un proceso lo retoma con sus metadatos.

**Notas destacadas por paso:** cada tarjeta de paso tiene un botón 📝 que despliega el `NoteEditor` (§10): tipo de admonition (nota/consejo/info/aviso/peligro), título opcional, barra que aplica los *Markdown Features* (negrita, cursiva, resaltado `<mark>`, código, enlaces, listas, emojis) sobre la selección y **vista previa en vivo** con el aspecto real del recuadro. La nota viaja con el paso (borrador incluido) y se publica en el MDX.

**Controles:** ● Grabar, ⏸ Pausar, ■ Detener y guardar. Atajo global `Ctrl+Shift+R` para pausar/reanudar sin tocar el panel.

**Encabezado del panel en dos filas.** Arriba, lo que **identifica** el panel (plegar, «Pasos», contador —que cuenta **pasos**, no secciones—) y los controles de grabación. Debajo, una **barra de herramientas** con lo que se **hace** con los pasos ya capturados: **«＋ Añadir»** (imagen pegada, captura de pantalla externa, bloque de contenido o **sección**, §15 y §16), **«✨ Redactar todos»** (§14) y el interruptor **«agrupar seguidos»** (§3, §17). Separarlas fue necesario al crecer: mezclado, ■ —la única salida del flujo— acababa rodeado de botones de edición o, con el panel estrecho, fuera de la vista. Ambas filas **envuelven** a propósito por el mismo motivo. Cuando hay pasos marcados, la segunda fila se convierte en la **barra de selección** (⊞ Agrupar / Eliminar / Cancelar, con el motivo si no se puede agrupar): las acciones son otras y mezclarlas confundía.

**Al pulsar ■** hay dos comportamientos distintos, y la diferencia es deliberada:

- **Falta un dato** (módulo, funcionalidad o carpeta de salida) o no hay pasos: la grabación **se detiene igualmente** y el aviso dice qué falta. Pulsar ■ significa «he terminado»; validar antes de detener hacía que el botón pareciese no responder. Los pasos se conservan (y el borrador se autoguarda): basta completar arriba y volver a pulsar.
- **Git activo**: el aviso de confirmación aparece **antes** de detener, e informa de la rama y el mensaje. Eso no es un error sino una decisión —el commit cuesta deshacerlo y la documentación puede no estar completa—, así que cancelar debe dejar seguir grabando sin tener que reanudar.

**Panel de pasos:** lista scrolleable de tarjetas. Cada tarjeta: **casilla de selección** (para agrupar, §3), miniatura clicable (abre la captura a tamaño real en modal), badge de número, título (input), descripción (textarea auto-resize), botón **✨** para redactarla con IA (§14), **▦** para su bloque de contenido y **📝** para su nota (§15, §10), chip con el selector preferido y su estrategia, toggle "incluir en docs", botones eliminar y arrastrar para reordenar (dnd-kit). Un paso agrupado lista además sus elementos, cada uno con un **✕** que lo quita del paso, y ofrece **⊟** para deshacer la agrupación (§3). Al llegar un paso nuevo durante la grabación, hacer scroll automático y enfocar el campo título para escribir la descripción al vuelo.

**Los pasos que no vienen del motor se distinguen de un vistazo** (`kind`): una captura externa lleva franja ámbar y el chip «captura ajena al visor» en lugar de selector; un bloque de contenido, franja azul, sin miniatura y con su editor desplegado. No tienen selector ni se regeneran, y confundirlos con un paso grabado llevaría a esperar de ellos algo que no pueden dar.

**El número del paso vive solo en la GUI y en el MDX**, nunca dentro del PNG: el orden cambia al eliminar o reordenar y los píxeles ya no se pueden rehacer (§3).

**Escritura de los textos:** el título y la descripción se publican tal cual, así que la ventana lleva **corrector ortográfico** y **menú contextual** propio (sugerencias, «añadir al diccionario», cortar/copiar/pegar). Electron no trae menú contextual, así que sin implementarlo el clic derecho no hace nada. Se aplica solo a la ventana de la aplicación: en el visor el menú es el del sistema documentado y abrirlo encima estorbaría a la grabación.

**Validación al guardar:** avisar si hay pasos sin título; permitir guardar de todos modos.

**Franja de estado y selector de rama de trabajo** (bajo la barra superior, ver §10): resume el repositorio de la sesión y contiene el **selector de rama de trabajo**, porque elegir dónde continuar es lo primero que se hace, no un ajuste enterrado en el panel. Muestra el repositorio, la rama de trabajo (pulsable), si esa rama va a nacer y de dónde, los cambios pendientes y el número de proyectos registrados.

**Sección Git** (dentro del panel, ver §10): aparece cuando la carpeta de salida está dentro de un repositorio. Casilla "Registrar en Git al guardar", campos de rama y mensaje (prerrellenados a partir de los metadatos), casilla de push (deshabilitada si no hay remoto `origin`), y avisos: si la rama ya existe o de qué rama nacerá, cambios sin guardar que impedirían el cambio de rama, o archivos ajenos ya indexados. El campo de rama edita el **mismo** estado que el selector de la franja. Cuando la carpeta **no** está en un repositorio, la sección lo explica en vez de desaparecer sin más.

**Explorador de repositorios** (modal "Proyectos…"): tres columnas — repositorios ya usados → ramas → historial de commits — de **solo lectura** sobre el repositorio. Permite: usar otro proyecto para la sesión (cambia la carpeta de salida), **trabajar en una rama** del repositorio de la sesión (lo mismo que el selector de la franja), **previsualizar** la documentación de un commit (pulsándolo) —sus pasos y capturas, leídos de Git con `git show` sin checkout ni Docusaurus— y, desde esa vista previa, **volver a editarla** (§16). "Quitar de la lista" solo olvida la entrada del registro; no toca el repositorio en disco.

**Borrador (continuar otro día)**: la grabación en curso se autoguarda en `userData/draft` (pasos + capturas durables), con retardo tras cada cambio. Al arrancar, si hay borrador, se ofrece continuar o descartarlo. Se descarta al guardar con éxito. Para las pruebas, el proceso principal acepta `DOCRECORDER_USER_DATA` y aísla todo el estado persistente en un `userData` propio, sin tocar el del usuario.

**Centro de ayuda** (botón "?"): modal con navegación de temas a la izquierda y contenido desplazable a la derecha (con resaltado del tema activo al desplazar). Documenta el uso, cada control, la integración con Git y con Docusaurus, y la solución de problemas.

**Aviso inicial de Docusaurus**: al arrancar se muestra un modal con lo esencial para que la documentación se vea en Docusaurus (elegir `docs/`, cambiar de rama para previsualizar). Incluye "No volver a mostrar" (persistido en `localStorage`) y es reabrible desde la ayuda.

**Aviso de raíz de Docusaurus**: si la carpeta de salida es la raíz de un proyecto Docusaurus (tiene `docusaurus.config.*` y una carpeta `docs/`), una franja avisa de que la documentación no se renderizaría ahí, con un atajo para cambiar a `docs/`. Es el error más común (§10).

**Estado inicial**: mientras no hay página cargada, la vista nativa se mantiene oculta y el hueco del visor muestra un onboarding (qué es la app y los tres pasos para empezar), en vez de un `about:blank` vacío.

**Modales y vista nativa**: el `WebContentsView` siempre se pinta sobre el HTML, así que cualquier superposición propia (diálogos, explorador, ayuda) oculta la vista nativa mientras está abierta.

Diseño limpio, denso en información, con **modo claro y oscuro** (interruptor en la barra; preferencia persistida, por defecto la del sistema); tipografía del sistema. Sin librerías UI pesadas (CSS propio con tokens de tema).

## 9. Seguridad y calidad

- `contextIsolation: true`, `nodeIntegration: false` en todos los renderers; IPC solo por `contextBridge` con canales tipados (definir un archivo `ipc-contract.ts` compartido).
- El viewport del sistema web NO recibe acceso a APIs de Node.
- No persistir credenciales del sistema documentado; su sesión vive en la partición del `WebContentsView` (`session.fromPartition('persist:target-app')`, para conservar el login entre usos).
- **Clave de la API de IA** (§14): se guarda en `userData/settings.json` cifrada con `safeStorage` (llavero del sistema operativo), **nunca** en el repositorio de documentación. No sale del proceso principal: el renderer solo puede guardarla y preguntar si existe. Si el sistema no ofrece cifrado, se guarda en claro y la GUI lo advierte.
- **Llamadas a la IA desde el proceso principal**, como las de Git: la clave no pasa por el renderer y las capturas se leen del disco allí.
- `shell:open-external` solo acepta `http`/`https`: el canal existe para abrir la consola del proveedor de IA, no para que el renderer lance `file://` ni esquemas del sistema.
- TypeScript estricto. ESLint + Prettier.
- Estructura de código: `src/main/` (main + engine + `ai/`), `src/preload/`, `src/renderer/`, `src/shared/` (tipos y contrato IPC).
- **Pruebas:** `npm run build && node scripts/smoke.mjs` — 111 comprobaciones de extremo a extremo que arrancan la app real y la manejan por CDP. Convención del proyecto: **cada arreglo llega con la prueba que lo demuestra**, y se comprueba que esa prueba **falla sin el arreglo**. Dos variables de entorno la sostienen: `DOCRECORDER_USER_DATA` (aísla el estado persistente) y `DOCRECORDER_AI_FAKE` (sustituye al proveedor de IA por una respuesta determinista, tras comprobar que hay clave). Lo que no se puede afirmar desde el DOM se comprueba **sobre los píxeles del PNG**, con un decodificador mínimo dentro del propio script.

## 10. Integración Git (GitHub Flow)

La documentación se registra en el repositorio Docusaurus **clonado** por quien documenta (§1), siguiendo GitHub Flow.

**Estrategia de ramas: una por módulo.** La rama sugerida es `docs/<módulo>` (`suggestBranchName`), y todas las funcionalidades de ese módulo se acumulan en ella (la app reutiliza una rama existente y añade el commit encima), de modo que el **módulo es la unidad de PR**. El mensaje de commit sí distingue funcionalidad: `docs(<módulo>): <título>`. La categorización del manual la da la estructura de carpetas `<módulo>/<funcionalidad>/` y el `_category_.json` (§7), no la rama; por eso agrupar por módulo en la rama no afecta a cómo se organiza el sitio. El campo Rama es editable: para un PR por funcionalidad, basta escribir `docs/<módulo>-<funcionalidad>`. Salvedad de GitHub Flow: las ramas son de vida corta (crear → PR → fusionar → borrar); tras fusionar el PR de un módulo conviene borrar su rama local para que una funcionalidad posterior nazca limpia de `main`.

### Principio de diseño: escribimos en un repositorio ajeno

Todo este módulo escribe en un repositorio que mantiene otra persona, así que las salvaguardas son parte del contrato, no un extra. Se invoca el `git` del sistema (no una implementación embebida) para respetar su configuración, credenciales y hooks.

- **Solo se indexan las rutas que escribe DocRecorder.** Nunca `git add -A`: barrería trabajo en curso ajeno hacia nuestro commit. Si hay cambios ajenos ya indexados, se aborta con un mensaje claro.
- **No se cambia de rama con archivos seguidos y modificados** que no sean nuestros: viajarían a la rama nueva y mezclarían trabajo en curso con la documentación.
- **No se hace push** salvo petición explícita, y **nunca** con `--force`.
- La detección es **local, sin red**: no hay `fetch`, `clone` ni llamadas a la API de GitHub. La app no crea repositorios.

### Rama base (corregido)

Cada rama de documentación nace de la **rama por defecto** del repositorio, no de `HEAD`. Con `git checkout -b <rama>` a secas, documentar dos funcionalidades seguidas encadenaba la segunda rama sobre la primera, y su PR arrastraba la documentación de la anterior. La base se resuelve así:

1. La rama elegida en el explorador (`GitSaveOptions.baseBranch`), si la hay.
2. Si no, `origin/HEAD` (lo que el repositorio declara como rama por defecto).
3. Respaldo: `main`, luego `master`.

Se ramifica desde la copia **local** de esa rama: partir de `origin/main` exigiría red y credenciales en cada guardado, y un PR desactualizado se rebasa igual en GitHub. Si no hay base reconocible, se conserva el comportamiento anterior (ramificar desde HEAD) y se avisa, antes que bloquear el guardado. Regrabar una funcionalidad **reutiliza** su rama y añade el commit encima.

### Rama de trabajo: continuar donde se dejó

El problema que resuelve: la rama era un **derivado** de los metadatos (`docs/<módulo>`), así que para volver a una rama empezada ayer había que reescribir la cabecera entera —módulo, funcionalidad, título, rol— confiando en que el nombre volviese a salir igual. Se invierte la dependencia: **la rama de trabajo es estado de primera clase de la sesión, y de ella se derivan los metadatos**.

- **La fuente de verdad es el repositorio, no un registro local.** `git:branch-docs` recorre el historial de la rama (`log --name-only -- '*session.json'`, ya ordenado por recencia) y lee esos `session.json` con `git show`. De ahí salen módulo, rol y URL base. Funciona igual si el commit lo hizo otra persona u otra máquina, que es lo que un registro en `userData` no puede garantizar. Se recorre el historial y no el árbol porque el árbol no dice cuál es el más reciente: habría que preguntar la fecha archivo a archivo.
- **Prefill sin pisar.** Elegir una rama rellena solo los campos **vacíos**; funcionalidad y título se dejan libres porque se va a documentar una nueva. Para retomar una concreta (ampliarla o regrabarla), el selector lista las funcionalidades de la rama y al pulsar una carga sus cuatro campos: si no coincidieran, la salida caería en otra carpeta.
- **Elegir no hace checkout.** La rama se cambia o se crea al guardar, con las salvaguardas de `commitDocs`. Hasta entonces es una declaración de intenciones, y por eso puede ofrecerse sin riesgo sobre un repositorio ajeno.
- **Herencia al arrancar.** Si el clon quedó en una rama de documentación (≠ rama por defecto) y esa rama ya documenta algo, se adopta con sus metadatos. Sin activar el registro en Git: heredar es una comodidad, decidir que se comitea sigue siendo del usuario.
- **Un solo estado, tres editores.** El selector de la franja, el campo Rama de la sección Git y el explorador escriben `gitBranchOverride`. La rama base (`gitBaseBranch`) queda para lo que de verdad es: de dónde nace una rama **nueva**, y se elige junto al nombre de esa rama.
- **Caché de ramas con invalidación explícita** (`useBranches`): listar ramas cuesta un proceso `git` por rama y la piden tres vistas a la vez. Se invalida en los dos momentos en que puede haber cambiado —después de guardar y al abrir el selector— porque una lista vieja engaña justo cuando importa: acaba de nacer una rama. Por lo mismo, guardar vuelve a inspeccionar el repositorio: antes la franja seguía describiendo el estado anterior al commit.

### Registro de repositorios y explorador

- El repositorio se recuerda **al commitear con éxito**, no al detectarlo: así la lista no se llena de intentos fallidos (persistencia en §7).
- El explorador (§8) lee ramas locales (`for-each-ref`) e historial (`log`), ambos de solo lectura, y no lista ramas remotas: la app no habla con la red.

### Documentación escrita y sin registrar en Git

Escribir el paquete y hacer el commit son dos pasos separados a propósito (§7: si el commit falla, la grabación no se pierde). La consecuencia es que puede haber documentación **entera en el disco y fuera del historial**: porque el commit falló, porque se guardó con la integración desmarcada o porque se cerró la app antes. `readBranchDocs` lee el **historial**, así que no ve nada de eso, y la franja de estado no contaba los archivos sin seguimiento: ese trabajo era invisible para la aplicación.

`git:pending-docs` lo lee. Parte de `git status` —una sola llamada, y es Git quien decide qué está al día— y de cada ruta pendiente **sube por los directorios** (hasta tres niveles) hasta encontrar el que tiene `session.json`: así una captura cambiada dentro de `img/` cuenta como su paquete y las rutas ajenas, que no cuelgan de ninguno, se descartan solas. Distingue el paquete **nunca commiteado** (`untracked`) del **commiteado y cambiado después**.

`git:commit-pending` lo registra: indexa la carpeta **entera tal como está en el disco** —no solo lo que `git status` marca, porque un `index.mdx` sin sus capturas no sirve— más los `_category_.json` de los niveles superiores que Git no tenga. Va a `docs/<módulo>` (la convención del proyecto, no el HEAD actual: el paquete pertenece a su módulo aunque el repositorio se haya quedado en otra rama), reutiliza `commitDocs` con sus salvaguardas y **nunca hace push**.

`git:discard-pending` es la operación contraria, y hacía falta: no todo lo que queda fuera del historial merece entrar en él (una grabación de prueba, un proceso documentado dos veces, un intento a medias), y sin ella la única salida era borrar carpetas a mano en el Finder, con el riesgo de llevarse por delante lo que sí estaba commiteado. Tres casos, ninguno fuera de la carpeta del paquete: lo que Git no conoce va a la **papelera del sistema** (`shell.trashItem`: reversible desde el escritorio, sin inventar una copia de seguridad propia); lo ya commiteado y modificado vuelve a su versión de HEAD (`git checkout HEAD -- <dir>`); y lo añadido al índice pero nunca commiteado sale del índice y va a la papelera. Si al quitar el paquete su categoría queda vacía, esa carpeta se va también —un `_category_.json` suelto dejaría un apartado vacío en el sidebar—, solo si tampoco estaba registrada. Si el sistema no puede mover algo a la papelera se **avisa** en vez de borrarlo igualmente: quien pidió «a la papelera» no pidió «bórralo para siempre». La prueba de humo borra directo (`DOCRECORDER_NO_TRASH`) para no ensuciar la papelera de quien la ejecuta.

En la GUI: aviso **⚠ N sin registrar** en la franja de estado, que abre la lista con módulo, pasos, archivos pendientes y carpeta de cada paquete, y por cada uno «Registrar en docs/&lt;módulo&gt;», «Retomar sus datos» (sus metadatos, como al retomar una rama), «Abrir carpeta» y «Descartar» (con confirmación que enumera exactamente qué va a pasar; es la única acción destructiva de la ventana).

### Salida para Docusaurus (renderizable)

Docusaurus renderiza `.md`/`.mdx`, no los JSON del grabador. Por eso, además del paquete reproducible, cada grabación genera la **página del manual en `index.mdx`** (`src/main/mdx.ts`): frontmatter (`title`, `sidebar_label`, `description`), un encabezado numerado por paso —que alimenta el índice lateral de Docusaurus— y su captura co-localizada (`![](./img/paso-NN.png)`). Los pasos marcados «no incluir en docs» se omiten y la numeración visible sigue siendo correlativa.

Detalles que hacen que el build de Docusaurus no falle:

- **Escape MDX**: el texto libre del usuario escapa `<`, `>`, `{`, `}` (Docusaurus v3 compila `.md`/`.mdx` con MDX; sin escape, un `<` rompería el build entero).
- **Sin enlaces rotos**: solo se referencia la captura de un paso si el archivo se llegó a escribir; una imagen inexistente abortaría el build.
- **`_category_.json`** por nivel con carpeta propia (módulo y, si la hay, subcategoría) para la etiqueta de la barra lateral, creado **solo si falta** (no se pisa la personalización del mantenedor). Con subcategoría, el sidebar de Docusaurus anida solo (categoría → subcategoría → páginas).
- **Notas destacadas**: la `note` de un paso se publica entre su descripción y su captura como un **admonition** de Docusaurus (`:::note`/`:::tip`/`:::info`/`:::warning`/`:::danger`), con su título opcional en `[...]`. Se redacta con un editor de barra + vista previa (`NoteEditor.tsx`), sin dependencias nuevas.
- **Bloques de contenido** (`DocStep.content`, §15): Markdown/MDX escrito por el usuario —tablas, bloques de código, pestañas, `<details>`— publicado entre los campos del paso y su nota. Un paso de tipo `content` es material de apoyo, no una acción: **no consume número de paso** (se titula con `###`) y no aparece en `flow.json`.
- **Saneado del contenido escrito a mano** (`src/shared/mdx-content.ts`, compartido por el generador y la vista previa): el cuerpo de notas y bloques pasa por `sanitizeContent`, que escapa `<` y `{`/`}` **salvo** en las etiquetas de una **lista blanca** que estén **bien cerradas** y **salvo dentro del código** (vallas ``` y `código en línea`, donde MDX no interpreta nada y donde escapar además rompería lo que se muestra, porque Markdown no descodifica entidades dentro de código). `>` no se escapa: MDX no le da significado y en Markdown abre una cita. Una etiqueta desconocida o sin cerrar se publica **como texto visible**, nunca activa, y el editor lo avisa. Este es el contrato que hace imposible que lo que escriba el usuario tumbe el build del mantenedor.
- **Imports automáticos**: si algún bloque usa `<Tabs>`/`<TabItem>`, las líneas `import` que Docusaurus exige se añaden **una sola vez** tras el frontmatter (`contentImports`). El usuario no tiene que saberlo.

La carpeta de salida debería ser la carpeta `docs/` del proyecto Docusaurus (o una subcarpeta suya). Verificado con un `docusaurus build` real sobre la salida generada: compila y renderiza el manual con sus pasos e imágenes.

### Canales IPC (todos de solo lectura salvo el guardado)

`git:inspect` (repo de la carpeta de salida), `git:branches`, `git:commits`, `git:branch-docs` (lo documentado en una rama), `git:commit-docs`, `git:commit-doc-edit` (una funcionalidad commiteada traída a la sesión, §16: lo único que escribe son sus PNG temporales), `git:doc-image`, `git:pending-docs` (lo escrito y sin registrar), `projects:list`, `projects:forget`. El commit ocurre dentro de `session:save`; los únicos canales de escritura fuera del guardado son `git:commit-pending` (registra un paquete ya escrito) y `git:discard-pending` (lo descarta). Ante cualquier fallo, los canales de lectura devuelven vacío en vez de propagar el error: la vista queda sin datos, que es un estado inocuo.

## 11. Criterios de aceptación

**MVP:**

1. Puedo abrir cualquier URL (con login manual dentro del viewport) y la sesión persiste al reabrir la app.
2. Con la grabación activa, cada clic e input relevante genera una tarjeta con captura resaltada correcta (incluso en modales y tras navegación cliente de Next).
3. Los inputs de texto se consolidan en un solo paso; las contraseñas quedan enmascaradas.
4. Puedo editar título/descripción, reordenar y eliminar pasos antes de guardar.
5. Al detener, se escribe la estructura del §7 y las imágenes coinciden con el orden final.
6. Cada paso guarda ≥1 selector candidato que NO depende de clases CSS hasheadas.
7. La app corre en Windows y Linux (desarrollo principal en el SO del autor).

**Integración Git (§10):**

8. Al elegir una carpeta dentro de un repositorio, la sección Git aparece sola; fuera de un repositorio, lo explica.
9. Documentar dos funcionalidades seguidas produce dos ramas hermanas desde la rama por defecto; la segunda no arrastra los archivos de la primera.
10. Nunca se indexan ni se comprometen archivos ajenos; sin remoto, el push no se intenta.
11. El explorador muestra repositorios, ramas e historial, y permite elegir la rama de trabajo sin escribir nada en el repositorio.
12. **Continuar donde se dejó:** elegir una rama ya empezada recupera el módulo, el rol y la URL base con los que se documentó, sin reescribirlos, y lista sus funcionalidades para retomar una concreta. Apuntar a un repositorio que quedó en su rama de documentación hace lo mismo solo.

**Fidelidad de la captura (§3):** cada una de estas nació de documentar el sistema real, y todas tienen su comprobación en el smoke.

13. Un gesto del usuario produce **un** paso: un interruptor que reenvía el clic a su `<input>` escondido no genera dos ni rompe el grupo del formulario.
14. La captura de un paso agrupado resalta **todos** sus campos, no solo el último.
15. El elemento señalado **se ve** aunque el fondo de un modal recién abierto lo oscurezca.
16. Un clic que cambia de pantalla (cerrar sesión) conserva la captura previa, con el elemento señalado, en vez de ilustrar la pantalla siguiente sin recuadro.
17. Eliminar o reordenar pasos nunca deja una captura contradiciendo su número.
18. Un menú que se **desvanece** al elegir una opción se documenta legible, no medio borrado.
19. Un botón que abre su menú en `pointerdown` (y cuya capa de descarte se traga el `pointerup`) genera su paso, con su nombre, no un «clic en `<body>`».
20. Marcar la casilla de dos filas de una tabla produce **dos** pasos, no un formulario agrupado.

**Asistencia de IA (§14):**

21. Sin clave configurada, redactar avisa de lo que falta en vez de fallar; la clave nunca vuelve al renderer y se guarda cifrada.
22. Cada proveedor guarda su propia clave y su propio modelo.
23. Redactar un paso no altera los demás, y «Redactar todos» omite los excluidos de la documentación.

## 12. Runner de regeneración

Cuando el sistema documentado cambia de interfaz, las capturas quedan desactualizadas. El runner (`src/main/engine/runner.ts`) re-ejecuta el flujo de una funcionalidad y **actualiza sus capturas** sin volver a grabar a mano.

- **Autenticación:** reutiliza la **sesión del visor**. El usuario inicia sesión en el sistema (visor) y luego lanza «Regenerar…»; el runner conduce esa misma página autenticada, así que hereda el login. No es un proceso aparte.
- **Entrada:** una carpeta de funcionalidad con su `session.json` (elegida con un selector). El runner navega a `baseUrl` y re-ejecuta cada paso.
- **Reproducibilidad:** cada paso se localiza probando sus `selectorCandidates` en orden (fallback). Un paso de formulario agrupado se re-ejecuta como sus acciones individuales (`DocStep.mergedActions`, que también expande `flow.json`) y captura **una** imagen tras completarlas.
- **Fallo:** si ningún selector encuentra el elemento, el paso se **marca como fallido**, conserva su captura anterior y el runner **sigue** con el resto. Al final, un informe por paso (regenerado / fallido).
- **Salida:** sobrescribe los `img/paso-NN.png` en disco; el usuario revisa y comitea con el flujo de Git normal (no se re-commitea solo).
- **UX:** el replay ocurre en el visor **visible** (para que las capturas salgan con el tamaño correcto); el informe se muestra al terminar.
- **Efecto secundario útil:** como rehace las imágenes con el motor actual, regenerar una funcionalidad antigua le aplica también las mejoras de captura posteriores a su grabación (sin el número quemado, con el grupo entero resaltado, sin el elemento apagado bajo un modal).

## 13. Sugerencia de plan de implementación (para el agente)

1. Scaffold electron-vite + React + TS, ventana con layout dividido y `WebContentsView` navegable.
2. Conexión CDP: lanzar con remote debugging, adjuntar Playwright al target del viewport, verificar `page.title()`.
3. Observador inyectado + IPC del evento crudo hasta la GUI (sin captura aún).
4. Generación de selectores + espera de estabilidad + captura con overlay.
5. Panel de tarjetas completo (edición, reorden, eliminación).
6. Guardado a disco + renombrado de imágenes + validaciones.
7. Pruebas manuales contra un sitio Next.js real; ajustar esperas y portales.

## 14. Asistencia de IA para redactar los pasos

El motor titula cada paso de forma mecánica (`Clic en «Guardar»`) y deja la descripción vacía. La asistencia de IA propone un **título** y una **descripción** mejores, que el usuario edita y acepta. Nada se escribe en la documentación hasta el guardado normal.

- **Proveedores:** Claude (Anthropic, `@anthropic-ai/sdk`) y Gemini (Google, `@google/genai`). Se elige uno; cada uno guarda su propia clave y su propio modelo. Los dos reciben **el mismo prompt y el mismo esquema de respuesta** (`src/main/ai/prompt.ts`), para que la redacción no dependa del proveedor.
- **Dónde vive la llamada:** en el **proceso principal** (`src/main/ai/`), como las de Git. La clave nunca pasa por el renderer y las capturas se leen del disco allí.
- **Clave:** se guarda en `userData/settings.json` (`src/main/settings.ts`), **cifrada con `safeStorage`** (llavero del sistema operativo). Nunca en el repositorio de documentación. Si el sistema no ofrece cifrado, se guarda en claro y la GUI lo advierte.
- **Contexto enviado:** los metadatos del manual, el **índice completo del flujo** (todos los títulos, para situar cada paso) y, por cada paso a redactar, su acción, el valor o los campos, la URL y —si el ajuste está activo— su **captura**. Las contraseñas ya viajan enmascaradas (`***`).
- **Material de referencia (contexto pegado):** `meta.aiContext`, un texto libre que escribe quien documenta (la tabla de campos del formulario, las reglas del proceso, un fragmento de código o SQL). Se envía **en cada lote**, al final de la cabecera del prompt y **delimitado** (`--- INICIO/FIN DEL MATERIAL DE REFERENCIA ---`), presentado explícitamente como datos y no como instrucciones: puede ser texto copiado de cualquier sitio y ahí cabe cualquier frase con forma de orden. Tope de 12 000 caracteres, porque se repite por lote. Viaja con el **borrador** (sobrevive a cerrar la app) y **no** se escribe en `session.json` ni en el MDX: es contexto para redactar, no contenido. Se edita con el botón **▢ Contexto** del encabezado del panel, junto a «Redactar todos», que es lo que le da sentido.
- **Al estrenar sesión se pregunta qué hacer con él.** El material describe el proceso que se acaba de terminar: conservarlo es lo correcto documentando varios procesos del mismo módulo, y un estorbo cuando la guía siguiente es de otra cosa —la IA redactaría con los nombres y las reglas de la anterior **sin que nadie lo note**, que es lo peor que puede hacer una ayuda automática—. Por eso no se decide por el usuario: al guardar (y al descartar una edición) sale un aviso con «Vaciar el contexto» / «Conservarlo». El aviso va **después** del de guardado, no encadenado a él.
- **Validación de la clave:** el campo está enmascarado, así que un pegado equivocado no se ve. `apiKeyProblem()` (en `src/shared/types.ts`, compartida por GUI y main) rechaza lo que no puede ser una clave —fuera de ASCII imprimible, o más de 300 caracteres— al guardarla, y también antes de llamar si quedó guardada por una versión anterior. Sin esa comprobación, la clave llega a una cabecera HTTP, que solo admite ASCII, y el error que sale (`Cannot convert argument to a ByteString…`) no menciona la clave por ningún lado.
- **Lotes:** los pasos se redactan de seis en seis. El contexto del flujo se envía una vez por lote, así que sale más coherente y más barato que una llamada por paso; el lote se mantiene pequeño para que el progreso avance a la vista y la petición no se dispare de tamaño.
- **Salida estructurada:** `output_config.format` en Claude y `responseSchema` en Gemini, con el mismo esquema. Solo se aceptan los `id` que se pidieron: un modelo que se invente un paso no puede sobrescribir otro.
- **Alcance en la GUI:** botón ✨ por paso y «✨ Redactar todos» en el encabezado del panel. «Todos» solo toca los pasos marcados como _incluir en docs_.
- **Fallos:** un error a mitad devuelve **lo ya redactado** más el motivo (clave inválida, límite de peticiones, modelo no disponible, sin conexión), traducido a un mensaje accionable.
- **Canales IPC:** `ai:status`, `ai:set-key`, `ai:set-settings` y `ai:draft`, más el evento `ai:progress` (avance tras cada lote). Ninguno devuelve la clave.
- **Pruebas:** la variable de entorno `DOCRECORDER_AI_FAKE` sustituye la llamada al proveedor por una respuesta determinista, después de comprobar que hay clave. Así el smoke recorre el circuito completo (ajustes → IPC → aplicar en el panel) sin red ni clave real. El prompt **sí se arma** en ese camino, y la respuesta simulada anota si traía material de referencia: es lo que permite comprobar que el contexto pegado llega hasta él sin enviar nada a ningún proveedor.
- **Estado de verificación:** el camino de **Gemini está probado contra la API real** (con y sin captura; los modelos ofrecidos se confirmaron existentes con `models.list`). El de **Claude solo está comprobado por tipos**: no había clave de Anthropic disponible. Si aparece una, conviene ejercitarlo con una sonda desechable antes de fiarse, porque es el proveedor por defecto.

## 15. Pasos que no graba el motor: capturas externas, imágenes pegadas y bloques de contenido

Un manual real no cabe entero dentro del navegador. Documentando el sistema de verdad aparecieron dos huecos que ninguna mejora del motor puede tapar, porque no ocurren en la página:

1. Parte del procedimiento pasa por **archivos y ventanas ajenas**: una plantilla de Excel que hay que rellenar, un PDF que hay que revisar, el correo que llega después.
2. Parte de la información **no es una pantalla**: la tabla de valores admitidos de un campo, un fragmento de código, lo que cambia según el rol.

Ambos se resuelven con el mismo mecanismo —un paso más de la lista, con su título, su descripción, su nota, su orden y su publicación— distinguido por `DocStep.kind`. Todo lo que no es `interaction` comparte tres reglas: **no aporta acciones a `flow.json`**, el **runner lo salta** (`status: 'skipped'`, que no es un fallo) y **no se puede agrupar**.

### Capturas externas (`kind: 'capture'`)

- **De dónde:** `desktopCapturer` (pantallas y ventanas, con miniatura para reconocerlas) o una **imagen del disco**. `src/main/capture.ts`; canales `capture:sources`, `capture:take`, `capture:import-file` y `capture:save-edited`.
- **Resolución:** la captura se pide al tamaño en píxeles reales del monitor mayor, no al de la miniatura, o el manual publicaría una imagen borrosa.
- **HiDocs se aparta:** al fotografiar una pantalla completa la ventana se oculta durante el disparo (con un respiro para que el compositor la retire) y vuelve siempre, también si falla.
- **Ajuste antes de aceptar:** casi nunca se documenta la pantalla entera. El editor permite **recortar** y **señalar** con el mismo recuadro `#FF5722` que el motor pone sobre los elementos de la página, para que la captura externa se lea como una más. Se compone en un `<canvas>` del renderer y se guarda con `capture:save-edited`.
- **CORS del protocolo `docshot:`**: recortar exige leer el lienzo, y sin `corsEnabled` en el esquema privilegiado Chromium bloquea la petición antes del handler. El handler responde `Access-Control-Allow-Origin: *`; solo sirve capturas de la propia sesión.
- **Permisos (macOS):** la grabación de pantalla se concede en Ajustes del sistema y no se puede pedir desde la app; se comprueba antes de listar (`getMediaAccessStatus`) para poder explicarlo en vez de devolver una lista vacía sin motivo.
- **La imagen viaja como cualquier otra:** vive en la carpeta temporal de la sesión, se ve por `docshot://`, la copia el borrador y acaba en `img/paso-NN.png`.
- **Pruebas:** `DOCRECORDER_CAPTURE_FAKE` sustituye la enumeración y el disparo por una pantalla sintética, igual que `DOCRECORDER_AI_FAKE` hace con la IA: `desktopCapturer` depende de qué ventanas haya abiertas y de un permiso que una prueba no puede conceder.

### Imágenes pegadas (`kind: 'image'`)

Documentando de verdad, buena parte de lo que hay que dejar dicho **ya está copiado**: el recorte hecho con las teclas del sistema, un diagrama de otra herramienta, la tabla de un correo. Obligar a guardarlo en un archivo para luego importarlo es un rodeo, y por eso pegar es una entrada de primera clase.

- **Cómo:** **⌘/Ctrl+V** con el panel enfocado, «＋ Añadir → 📋 Imagen del portapapeles» (lo mismo con el ratón) y «＋ Añadir → ✂ Pegar y ajustar…» (pasa por el editor de recorte antes de crear la tarjeta). Dentro del diálogo de la imagen, pegar también cambia la imagen que se está ajustando.
- **Qué sale, según lo que haya copiado:** una **imagen** → paso `image`; **texto o HTML** → **bloque de contenido**, con las tablas ya convertidas (misma conversión que al pegar dentro del editor). La imagen manda sobre el texto: copiar de una hoja de cálculo trae ambas cosas y quien pega una captura espera la captura.
- **Se escucha `keydown` Y `paste`, y no es redundante:** fuera de un campo editable Chromium emite `keydown` pero **no** `paste` —el evento de pegado solo existe cuando el pegado tiene dónde caer—, así que sin el `keydown` (que lee el portapapeles por `clipboard:read`) el atajo sencillamente no existiría; y el `paste` hace falta porque cuando sí llega trae los datos consigo. Cuando un mismo gesto dispara los dos manda la tecla (llega primero) y el evento que venga detrás se descarta como eco (`keyPasteAt`, 250 ms). La ventana es corta a propósito: cubre el eco de una pulsación, no dos pegados seguidos, que son dos tarjetas legítimas. Comprobado sobre la app real con `Input.dispatchKeyEvent` + `commands: ['Paste']`.
- **Una sola decisión para las dos entradas:** qué hacer con lo pegado vive en `paste-step.ts` / `usePasteStep.ts`, no en cada entrada; si el evento llega vacío se cae al proceso principal (`clipboard:read`, `clipboard.readImage()`).
- **No se roba el pegado de nadie:** dentro de un campo de texto (título, descripción, bloque de contenido) ⌘V sigue pegando texto ahí (`isEditable`), y con una superposición abierta manda ella.
- **Cualquier formato entra como PNG:** lo que ya llega en PNG (el caso normal) se guarda tal cual y lo demás pasa por un `<canvas>`, que es lo que produce el motor y lo que espera `capture:save-edited`; de paso, lo que el navegador no sabe decodificar se rechaza en vez de escribir un archivo ilegible. **Sin `URL.createObjectURL`**: el CSP de la ventana solo admite `img-src 'self' data: docshot:`, y un `blob:` se bloquea antes de decodificarse, así que el archivo se lee como data URI (`FileReader`).
- **`kind` propio, y no `capture`:** una imagen pegada no salió de esta máquina. Se distingue en la tarjeta (borde verde, chip «imagen pegada») y sobre todo ante la IA, que si no describiría «la ventana que has capturado» sobre un diagrama que nadie sabe de dónde vino. En el manual sí se numera como un paso más: documenta algo que hay que mirar, a diferencia del bloque de contenido.
- **Retocar después:** el botón **✂** de las tarjetas cuya imagen es del usuario (`image` y `capture`) reabre el editor de recorte/señalado sobre la imagen que ya tienen, y solo sustituye la imagen: el título, la descripción y la nota se conservan.

### Dónde se inserta un paso nuevo

**Todos** los pasos —lo que se añade a mano y también **lo que graba el motor**— se colocan **justo detrás de la tarjeta activa** (`activeStepId`), no al final de la lista. La tarjeta activa es la última que llegó grabando o la última que el usuario tocó.

Que la regla sea una sola es lo que la hace predecible: grabando de corrido la tarjeta activa es siempre la última —cada paso nuevo la mueve—, así que el comportamiento normal no cambia; y cuando se vuelve a un paso del medio porque faltaba algo, lo que se grabe (o se pegue) entra **ahí** en vez de aparecer al final de cincuenta pasos y tener que arrastrarlo de vuelta. La fusión automática de campos de formulario mira, por tanto, al **vecino de arriba del punto de inserción**, no al último paso de la lista. Sin tarjeta activa —o si ya no existe— se añade al final, y el tooltip de «＋ Añadir» dice cuál de las dos cosas va a pasar.

### Bloques de contenido (`DocStep.content`, y `kind: 'content'` cuando el paso es solo eso)

- **Dónde:** cualquier paso puede llevar uno (botón ▦), y «＋ Añadir» crea un paso que es únicamente contenido, para material que no pertenece a ninguna acción concreta.
- **Qué se escribe:** Markdown/MDX de Docusaurus — tablas, bloques de código con `title=`, `<Tabs>`, `<details>`, admonitions, encabezados, listas, citas y formato en línea. La barra los inserta; no hay que recordar la sintaxis.
- **Pegar una tabla del sistema documentado** la convierte a tabla Markdown (`html-to-markdown.ts`, con `DOMParser`): es el atajo que evita teclear a mano las columnas de algo que ya está en pantalla.
- **La vista previa es el contrato:** `renderMarkdown` (renderer) renderiza **el mismo texto saneado** que se escribe en el `.mdx` (`sanitizeContent`, §10). Lo que aquí se ve escapado, allí se publica escapado. Sin esa garantía, «pásale el código y velo» sería una promesa que la app no puede cumplir. Con **⤢** se edita a pantalla completa, con el código y el resultado lado a lado (el panel es estrecho a propósito y una tabla de cinco columnas no se corrige a ciegas).
- **No numera:** un bloque de contenido no es un paso que nadie ejecute, así que no consume número; se publica con un encabezado `###` subordinado al paso anterior.

## 16. Secciones y reedición de lo ya publicado

Dos huecos que aparecieron al documentar procesos reales del sistema: una grabación larga no se puede leer ni mover por partes, y lo ya commiteado no se podía corregir sin volver a grabarlo entero.

### Secciones (`kind: 'section'`)

Agrupar (§3) une varios pasos en **uno**. Una sección hace lo contrario: los deja como están y les pone un **apartado** encima. Un proceso real tiene fases («preparación», «registro», «cierre») y treinta pasos seguidos no se manejan ni se leen.

- **Modelo:** un paso más de la lista, con `kind: 'section'`. Su pertenencia es **posicional** —le cuelgan los pasos que van detrás hasta la sección siguiente— y no un campo `sectionId` en cada paso: así reordenar, eliminar o deshacer una agrupación no puede dejar referencias huérfanas, y el modelo persistido no gana un campo que haya que mantener coherente.
- **No es un paso:** no se numera (`renumber` la salta), no lleva captura, no aporta acciones a `flow.json`, el runner la marca `skipped`, no se agrupa y no se manda a redactar con IA (su título lo pone quien decide la estructura).
- **Panel:** tarjeta propia (`SectionCard`), con lo poco que tiene sentido en ella —plegar, título, recuento de pasos, entradilla opcional y quitar—. Colar los controles de un paso apagados solo haría ruido. Los pasos que le cuelgan van **sangrados**: sin ese escalón la sección parece un separador suelto y no se ve dónde acaba el apartado.
- **Plegar** (`collapsedSections`) es **estado de la vista**: no viaja al paquete ni al borrador. Si un paso nuevo cae dentro de una sección plegada, se despliega sola: un paso que llega y no se ve parecería que la grabación dejó de funcionar.
- **Arrastrar una sección la mueve con sus pasos** (`reorderSteps` detecta el bloque). Es su razón de ser: reordenar un apartado de doce pasos era doce arrastres.
- **Quitarla elimina solo el título**; sus pasos se conservan y pasan al apartado anterior. Un borrado en cascada perdería media grabación de un clic.
- **Se inserta detrás de la tarjeta activa**, como todo lo demás: el título de un apartado se pone marcando el último paso del apartado anterior.
- **En el MDX:** la sección sale como `##` y **los pasos bajan a `###`** (y los bloques de contenido a `####`), de modo que el índice lateral de Docusaurus muestra la página por apartados. La **numeración de los pasos sigue corrida** entre apartados: quien ejecuta el proceso cuenta pasos, no capítulos. Una página **sin** secciones se publica exactamente igual que antes (`##` por paso), así que nada de lo ya commiteado cambia de forma.

### Volver a editar una funcionalidad ya commiteada

La vista previa de un commit termina, casi siempre, en «esto hay que corregirlo». `git:commit-doc-edit` cierra el círculo: lee el `session.json` del commit y **materializa sus capturas** como PNG temporales, para que a partir de ahí sean pasos normales del panel (reordenar, redactar con IA, añadir pasos o secciones) y al guardar se copien a `img/paso-NN.png` como cualquier otro. Sin materializarlas, volver a guardar dejaría el paquete sin sus imágenes.

- **Sigue siendo solo lectura sobre el repositorio:** no hay checkout ni cambio de rama al cargar. La sesión adopta los metadatos del commit, la **rama del commit** como rama de trabajo y una **carpeta de salida deducida** quitando de la ruta los niveles que la propia sesión declara (módulo, subcategoría, funcionalidad). Guardando con esos metadatos, el paquete se reescribe **donde estaba** en vez de duplicarse en otra rama del árbol.
- **El commit original no se toca:** la corrección se apila encima, en la misma rama. El historial sigue contando lo que pasó.
- **Se puede cancelar, y eso hay que decirlo.** Cargar un commit llena el panel de pasos que nadie ha grabado en esta sesión, y en un panel así la única salida visible es ■, que guarda **y comitea**: quien abrió algo para mirarlo se encontraba con que salir era publicar. La sesión marca su origen (`store.editing`) y el panel lleva arriba una **franja de edición** con qué se edita, de qué commit salió, dónde se registrará y **«Descartar la edición»** (con confirmación). Descartar vacía el panel, borra el borrador y limpia funcionalidad y título —módulo, subcategoría, rol y URL base se conservan, son de la categoría—; no escribe nada en el repositorio, porque cargar solo leyó de Git. El marcador se limpia también al guardar, al estrenar sesión, al restaurar un borrador y al elegir otro proceso o categoría, que son los momentos en los que deja de ser cierto.
- **Avisa antes de pisar:** si hay una grabación en curso, cargar sustituye los pasos y el borrador; se confirma primero.
- **Cambiar de rama con el paquete ya escrito** (`checkoutKeepingOurFiles`): Git aborta un `checkout` si en el árbol hay archivos **sin seguimiento** que la rama de destino también tiene, y eso es exactamente lo que ocurre al reescribir una funcionalidad ya documentada estando en otra rama (el paquete se escribe primero, §7). La salida es apartar **solo nuestros archivos** —los que ese guardado acaba de escribir—, cambiar de rama y volver a ponerlos encima; se reponen siempre, también si el checkout falla. Un archivo ajeno sigue abortando el cambio de rama con el mensaje de Git, que es lo correcto: no es nuestro. Esto afectaba también a regrabar una funcionalidad existente desde otra rama, así que el arreglo vive en `commitDocs` y no en el camino de la reedición.

## 17. Carpetas de capturas (`kind: 'group'`)

Un paso del manual necesita a veces **varias imágenes**: las tres pantallas de un asistente, lo que se ve antes y después de guardar, la pantalla del sistema junto al correo que llega. Hasta aquí había dos herramientas y ninguna servía: **agrupar** (§3) funde acciones y deja **una** captura —y exige pasos seguidos del flujo, y rechaza las capturas externas y las imágenes pegadas—, y una **sección** (§16) no es un paso, es un apartado. La carpeta es la tercera pieza: **un paso del manual cuyas ilustraciones son las de los pasos que se meten dentro**.

- **Modelo:** un paso más de la lista, con `kind: 'group'`. Su contenido es **explícito**: cada miembro lleva `groupId` con el id de la carpeta. Aquí la pertenencia **no** es posicional —al revés que en las secciones— porque una carpeta es un bloque cerrado: si dependiera de la posición, el paso siguiente que se grabara entraría dentro sin que nadie lo pidiera.
- **Invariante:** `regroup()` se aplica en **toda** renumeración, así que cada carpeta va siempre seguida de sus miembros y nadie apunta a una carpeta que no existe (quitarla libera sus pasos, no los pierde). Al ser una invariante y no una comprobación puntual, el resto del código —dibujar, mover, publicar— puede dar el bloque por contiguo venga de donde venga: arrastrar, grabar en medio, un borrador de ayer o un commit.
- **Meter y sacar.** Meter es **arrastrar la tarjeta a la zona de la carpeta** (`useDroppable`, id `group-drop:<id>`), con una detección de colisiones propia: la zona gana solo si el **puntero está dentro** de ella (`pointerWithin`), y en cualquier otro sitio se reordena como siempre (`closestCenter`). Sin esa separación no habría forma de mover un paso por delante de una carpeta sin meterlo dentro. Sacar es el botón **⤴**, o arrastrar el miembro fuera del bloque: si al soltarlo ya no tiene delante ni su carpeta ni un compañero, deja de pertenecer a ella. Meter **no** ocurre por posición, o cualquier paso soltado detrás del bloque acabaría dentro.
- **Lo que se añade con la carpeta marcada entra dentro**, al final de lo que ya guarda: se la está llenando. Con una captura suya marcada, lo nuevo va justo detrás de ella, como en el resto del panel (§15). Una sección o una carpeta nunca se anidan.
- **Numeración:** la carpeta consume número; sus capturas no (`renumber` las salta). En el panel se rotulan `5·1`, `5·2`…, y el recuento del encabezado no las suma: son las ilustraciones de un paso, no pasos.
- **Dentro se sigue trabajando igual:** cada miembro conserva su título —que se publica como **pie** de su imagen—, su descripción, su recorte, su nota y su bloque de contenido. Y **conserva lo suyo como paso**: un paso grabado metido en una carpeta sigue aportando su acción a `flow.json` y el runner lo regenera como cualquier otro. La carpeta, en cambio, no tiene captura propia, no aporta acciones y el runner la marca `skipped`.
- **Panel:** tarjeta propia (`GroupCard`) con plegado, título, descripción, recuento, ▦/📝/✨ y la zona de soltar; sus miembros se dibujan **debajo, sangrados** y con el mismo borde de color, porque siguen siendo tarjetas normales del panel (arrastrables y editables). Plegada, enseña sus capturas **en miniatura**: es lo que permite trabajar con una lista larga sin abrirla para recordar qué había dentro.
- **En el MDX:** la carpeta sale como un paso numerado con su título y su descripción, y debajo van sus imágenes en orden, cada una precedida de su pie en negrita. Si la carpeta se excluye de la documentación, sus capturas se van con ella: sacarlas sueltas convertiría un paso en cuatro.
- **Se agrupa lo que no se puede agrupar:** una carpeta admite capturas externas, imágenes pegadas, bloques de contenido y pasos grabados que no están al lado. `selectionProblem` sigue rechazando ⊞ Agrupar sobre ellos y ahora lo dice: para juntar *capturas*, la herramienta es la carpeta.
