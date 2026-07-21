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
  3. Dibuja el **highlight** inyectando un overlay absoluto (borde 3px `#FF5722`, radio 6px) sobre el `boundingRect`. Si algo ha quedado **por encima** del elemento (`isCovered`, vía `elementFromPoint`) —el fondo translúcido de un modal recién abierto, casi siempre— el recuadro añade `backdrop-filter: brightness()`, que le devuelve el brillo solo en esa zona: si no, el paso señalaría un elemento apagado justo cuando pide mirarlo. **Sin número**: el orden de los pasos cambia al eliminar o reordenar, y un número pintado en el PNG no se puede rehacer —son píxeles—, así que acabaría contradiciendo al paso que ilustra. El número lo ponen quienes sí pueden mantenerlo al día: la tarjeta del panel y el encabezado del MDX.
  4. Toma la captura (`page.screenshot`, viewport completo, PNG).
  - **Clics que navegan** (cerrar sesión, un enlace): la captura se toma tras esperar estabilidad, pero para entonces la página es otra y el elemento a señalar ya no existe; el paso ilustraba la pantalla siguiente y sin recuadro. Medido: una vez arrancada la navegación, **Chromium aplaza la ejecución de scripts** (`Runtime.evaluate` tardaba ~900 ms y respondía ya sobre la página nueva), así que el resaltado no puede dibujarse desde el motor. Por eso el **observador lo dibuja de forma síncrona** al recibir el clic, antes de la acción por defecto, y el motor solo captura —eso sí llega mientras la página anterior siga a la vista—. Esa captura previa se usa únicamente si al estabilizar ya no se puede señalar el elemento. La captura previa usa **CDP en crudo** y no la API de Playwright, que espera a que termine toda navegación pendiente.
  5. Remueve el overlay.
  6. Emite el paso a la GUI por IPC.
- Inputs de texto: consolidar en UN paso por campo (valor final), no un paso por tecla. Los campos de contraseña registran la acción pero guardan el valor como `"***"`.
- **Agrupar campos de formulario** (interruptor en el panel, preferencia persistida, por defecto activo): la GUI funde `fill`/`select` seguidos de la misma URL en un solo paso, con una sola captura (el formulario relleno) y la lista de campos en `DocStep.fields` (etiqueta+valor). Reduce drásticamente las imágenes: un formulario de N campos pasa de N pasos a uno. La fusión es una decisión de la GUI (`store.addStep`), no del motor, que sigue emitiendo un evento por campo. Se rompe con un clic en un botón, un envío o una navegación.
  - **Qué cuenta como campo:** no basta la etiqueta HTML. Se reconoce por tres vías, en este orden: el elemento **es** un control (`input`/`select`/`textarea` o un **rol ARIA** de campo — `FIELD_ROLES` en `recorder.ts`); es una **`<label>`** que acciona uno; o es el **envoltorio** de un control estilizado, que el observador detecta subiendo unos pocos niveles hasta un contenedor con **exactamente un** control (`fieldWrapperOf`). Ese último caso es el de los interruptores actuales, donde el `<input>` real está escondido y lo que se pulsa es un `<span>` **hermano** suyo. Un `button`, `a` o `[role=tab]` nunca cuenta como campo aunque esté junto a uno: debe cerrar el grupo.
  - **Un gesto, un paso:** un solo clic puede generar varios eventos —el navegador reenvía el clic de una `<label>` a su control, y un interruptor acciona por código el `<input>` que esconde—. El observador descarta los reenvíos: mismo gesto si llegan dentro de `SAME_GESTURE_MS` y, además, uno contiene al otro, comparten envoltorio de campo, o el segundo no es de confianza (`isTrusted`). Se documenta el primero, que es el visible y el que da mejor selector.
  - **Resaltado del grupo:** la captura de un paso agrupado marca **todos** sus campos, no solo el último. Al fundir, la GUI pide al motor una captura nueva (`recorder:capture-group`) con un recuadro por campo. Por eso el observador conserva las referencias a los elementos en vez de liberarlas al capturar, y recalcula los rectángulos en el momento de la captura (la página puede haber rodado).
  - **Fuente de verdad:** en la GUI el grupo vive en `RecordedStep.groupItems` (etiqueta, valor, acciones y referencias por campo). De ahí se derivan `fields` y `mergedActions`, de modo que **quitar un campo** de la tarjeta se lleva también su acción del `flow.json` y su resaltado. No se permite vaciar el grupo: para eso está eliminar el paso.

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
  action: 'click' | 'fill' | 'select' | 'submit' | 'press' | 'navigate'
  title: string // editable por el usuario
  description: string // editable por el usuario
  selectorCandidates: SelectorCandidate[]
  value?: string // para fill/select ("***" si es password)
  fields?: { label: string; value: string }[] // formulario agrupado (§3): campos de varios fill/select unidos
  mergedActions?: FlowAction[] // acciones individuales del paso agrupado, para que el runner lo reproduzca (§12)
  url: string // metadato
  screenshot: string // ruta relativa: img/paso-03.png
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
  groupItems?: GroupedField[] // fuente de verdad del formulario agrupado (§3)
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
    └── <feature>/
        ├── index.mdx        # página del manual que renderiza Docusaurus (§10)
        ├── session.json     # DocSession completa
        ├── flow.json        # solo acciones + selectores (insumo del runner futuro)
        └── img/
            ├── paso-01.png
            ├── paso-02.png
            └── ...
```

Nomenclatura: kebab-case en carpetas, `paso-NN.png` con cero a la izquierda. Al reordenar pasos en la GUI, renombrar las imágenes al guardar para que el orden en disco siempre coincida. Los `.json` conviven con el `.mdx` sin estorbar: Docusaurus solo procesa `.md`/`.mdx` y `_category_.json`.

**Registro de proyectos.** La lista de repositorios ya usados se guarda **fuera** del paquete de documentación, en `app.getPath('userData')/projects.json`: es una preferencia de la máquina, no del repositorio, y escribir estado dentro de un repositorio ajeno sería justo lo que las salvaguardas de §10 evitan. La escritura es atómica (archivo temporal + `rename`) para que un cierre a medias no lo corrompa.

## 8. GUI (renderer)

Layout: viewport a la izquierda (flexible, ~70%), panel derecho fijo (mín. 440px).

**Barra superior de sesión:** campos módulo/funcionalidad/título/rol, URL base + botón "Abrir", selector de carpeta de salida, botón "Proyectos…" (explorador de repositorios), "Regenerar…" (runner, §12), "IA" (ajustes de redacción, §14; muestra ✓ cuando hay clave), interruptor de tema y ayuda, e indicador de estado (Listo / Grabando / Pausado).

**Controles:** ● Grabar, ⏸ Pausar, ■ Detener y guardar. Atajo global `Ctrl+Shift+R` para pausar/reanudar sin tocar el panel. En el encabezado del panel conviven además el interruptor **«agrupar campos»** (§3) y **«✨ Redactar todos»** (§14); el encabezado **envuelve** a propósito, porque si no los controles de grabación se salen del panel cuando es estrecho y ■ queda inalcanzable —y con él la única salida del flujo—.

**Al pulsar ■** hay dos comportamientos distintos, y la diferencia es deliberada:

- **Falta un dato** (módulo, funcionalidad o carpeta de salida) o no hay pasos: la grabación **se detiene igualmente** y el aviso dice qué falta. Pulsar ■ significa «he terminado»; validar antes de detener hacía que el botón pareciese no responder. Los pasos se conservan (y el borrador se autoguarda): basta completar arriba y volver a pulsar.
- **Git activo**: el aviso de confirmación aparece **antes** de detener, e informa de la rama y el mensaje. Eso no es un error sino una decisión —el commit cuesta deshacerlo y la documentación puede no estar completa—, así que cancelar debe dejar seguir grabando sin tener que reanudar.

**Panel de pasos:** lista scrolleable de tarjetas. Cada tarjeta: miniatura clicable (abre la captura a tamaño real en modal), badge de número, título (input), descripción (textarea auto-resize), botón **✨** para redactarla con IA (§14), chip con el selector preferido y su estrategia, toggle "incluir en docs", botones eliminar y arrastrar para reordenar (dnd-kit). Un paso de formulario agrupado lista además sus campos, cada uno con un **✕** que lo quita del paso (§3). Al llegar un paso nuevo durante la grabación, hacer scroll automático y enfocar el campo título para escribir la descripción al vuelo.

**El número del paso vive solo en la GUI y en el MDX**, nunca dentro del PNG: el orden cambia al eliminar o reordenar y los píxeles ya no se pueden rehacer (§3).

**Escritura de los textos:** el título y la descripción se publican tal cual, así que la ventana lleva **corrector ortográfico** y **menú contextual** propio (sugerencias, «añadir al diccionario», cortar/copiar/pegar). Electron no trae menú contextual, así que sin implementarlo el clic derecho no hace nada. Se aplica solo a la ventana de la aplicación: en el visor el menú es el del sistema documentado y abrirlo encima estorbaría a la grabación.

**Validación al guardar:** avisar si hay pasos sin título; permitir guardar de todos modos.

**Sección Git** (dentro del panel, ver §10): aparece cuando la carpeta de salida está dentro de un repositorio. Casilla "Registrar en Git al guardar", campos de rama y mensaje (prerrellenados a partir de los metadatos), casilla de push (deshabilitada si no hay remoto `origin`), y avisos: de qué rama nacerá la nueva, cambios sin guardar que impedirían el cambio de rama, o archivos ajenos ya indexados. Cuando la carpeta **no** está en un repositorio, la sección lo explica en vez de desaparecer sin más.

**Explorador de repositorios** (modal "Proyectos…"): tres columnas — repositorios ya usados → ramas → historial de commits — de **solo lectura** sobre el repositorio. Permite: usar otro proyecto para la sesión (cambia la carpeta de salida), elegir la rama base de la próxima grabación, y **previsualizar** la documentación de un commit (pulsándolo) —sus pasos y capturas, leídos de Git con `git show` sin checkout ni Docusaurus. "Quitar de la lista" solo olvida la entrada del registro; no toca el repositorio en disco.

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
- **Pruebas:** `npm run build && node scripts/smoke.mjs` — 100 comprobaciones de extremo a extremo que arrancan la app real y la manejan por CDP. Convención del proyecto: **cada arreglo llega con la prueba que lo demuestra**, y se comprueba que esa prueba **falla sin el arreglo**. Dos variables de entorno la sostienen: `DOCRECORDER_USER_DATA` (aísla el estado persistente) y `DOCRECORDER_AI_FAKE` (sustituye al proveedor de IA por una respuesta determinista, tras comprobar que hay clave). Lo que no se puede afirmar desde el DOM se comprueba **sobre los píxeles del PNG**, con un decodificador mínimo dentro del propio script.

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

### Registro de repositorios y explorador

- El repositorio se recuerda **al commitear con éxito**, no al detectarlo: así la lista no se llena de intentos fallidos (persistencia en §7).
- El explorador (§8) lee ramas locales (`for-each-ref`) e historial (`log`), ambos de solo lectura, y no lista ramas remotas: la app no habla con la red.

### Salida para Docusaurus (renderizable)

Docusaurus renderiza `.md`/`.mdx`, no los JSON del grabador. Por eso, además del paquete reproducible, cada grabación genera la **página del manual en `index.mdx`** (`src/main/mdx.ts`): frontmatter (`title`, `sidebar_label`, `description`), un encabezado numerado por paso —que alimenta el índice lateral de Docusaurus— y su captura co-localizada (`![](./img/paso-NN.png)`). Los pasos marcados «no incluir en docs» se omiten y la numeración visible sigue siendo correlativa.

Detalles que hacen que el build de Docusaurus no falle:

- **Escape MDX**: el texto libre del usuario escapa `<`, `>`, `{`, `}` (Docusaurus v3 compila `.md`/`.mdx` con MDX; sin escape, un `<` rompería el build entero).
- **Sin enlaces rotos**: solo se referencia la captura de un paso si el archivo se llegó a escribir; una imagen inexistente abortaría el build.
- **`_category_.json`** por módulo para la etiqueta de la barra lateral, creado **solo si falta** (no se pisa la personalización del mantenedor).

La carpeta de salida debería ser la carpeta `docs/` del proyecto Docusaurus (o una subcarpeta suya). Verificado con un `docusaurus build` real sobre la salida generada: compila y renderiza el manual con sus pasos e imágenes.

### Canales IPC (todos de solo lectura salvo el guardado)

`git:inspect` (repo de la carpeta de salida), `git:branches`, `git:commits`, `projects:list`, `projects:forget`. El commit ocurre dentro de `session:save`. Ante cualquier fallo, los canales de lectura devuelven vacío en vez de propagar el error: la vista queda sin datos, que es un estado inocuo.

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
11. El explorador muestra repositorios, ramas e historial, y permite elegir la rama base de la próxima grabación sin escribir nada en el repositorio.

**Fidelidad de la captura (§3):** cada una de estas nació de documentar el sistema real, y todas tienen su comprobación en el smoke.

12. Un gesto del usuario produce **un** paso: un interruptor que reenvía el clic a su `<input>` escondido no genera dos ni rompe el grupo del formulario.
13. La captura de un paso agrupado resalta **todos** sus campos, no solo el último.
14. El elemento señalado **se ve** aunque el fondo de un modal recién abierto lo oscurezca.
15. Un clic que cambia de pantalla (cerrar sesión) conserva la captura previa, con el elemento señalado, en vez de ilustrar la pantalla siguiente sin recuadro.
16. Eliminar o reordenar pasos nunca deja una captura contradiciendo su número.

**Asistencia de IA (§14):**

17. Sin clave configurada, redactar avisa de lo que falta en vez de fallar; la clave nunca vuelve al renderer y se guarda cifrada.
18. Cada proveedor guarda su propia clave y su propio modelo.
19. Redactar un paso no altera los demás, y «Redactar todos» omite los excluidos de la documentación.

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
- **Lotes:** los pasos se redactan de seis en seis. El contexto del flujo se envía una vez por lote, así que sale más coherente y más barato que una llamada por paso; el lote se mantiene pequeño para que el progreso avance a la vista y la petición no se dispare de tamaño.
- **Salida estructurada:** `output_config.format` en Claude y `responseSchema` en Gemini, con el mismo esquema. Solo se aceptan los `id` que se pidieron: un modelo que se invente un paso no puede sobrescribir otro.
- **Alcance en la GUI:** botón ✨ por paso y «✨ Redactar todos» en el encabezado del panel. «Todos» solo toca los pasos marcados como _incluir en docs_.
- **Fallos:** un error a mitad devuelve **lo ya redactado** más el motivo (clave inválida, límite de peticiones, modelo no disponible, sin conexión), traducido a un mensaje accionable.
- **Canales IPC:** `ai:status`, `ai:set-key`, `ai:set-settings` y `ai:draft`, más el evento `ai:progress` (avance tras cada lote). Ninguno devuelve la clave.
- **Pruebas:** la variable de entorno `DOCRECORDER_AI_FAKE` sustituye la llamada al proveedor por una respuesta determinista, después de comprobar que hay clave. Así el smoke recorre el circuito completo (ajustes → IPC → aplicar en el panel) sin red ni clave real.
- **Estado de verificación:** el camino de **Gemini está probado contra la API real** (con y sin captura; los modelos ofrecidos se confirmaron existentes con `models.list`). El de **Claude solo está comprobado por tipos**: no había clave de Anthropic disponible. Si aparece una, conviene ejercitarlo con una sonda desechable antes de fiarse, porque es el proveedor por defecto.
