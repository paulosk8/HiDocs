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

**Fuera de alcance** (etapas futuras, pero el diseño debe dejarlas fáciles):

- Runner de regeneración headless con Playwright.
- Asistencia de IA para redactar descripciones.

## 2. Stack técnico

- **Electron** (última estable) con **electron-vite** como tooling.
- **React 18 + TypeScript** en el renderer (GUI).
- **`WebContentsView`** de Electron para el viewport embebido (NO iframe, NO `<webview>` tag deprecado).
- **Playwright** (`playwright-core`) conectado al viewport vía **CDP**: Electron se lanza con `--remote-debugging-port`, y un módulo "motor" usa `chromium.connectOverCDP()` para adjuntarse al `WebContentsView` del sistema web. Playwright se usa desde ya para observar el DOM y generar selectores, de modo que en la etapa 3 (runner) los mismos selectores sean reproducibles sin conversión.
- **zustand** (o similar ligero) para estado del panel de pasos.
- Persistencia simple en disco (JSON + PNG). Sin base de datos.

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
  3. Dibuja el **highlight** inyectando un overlay absoluto (borde 3px `#FF5722`, radio 6px, badge circular numerado en la esquina superior izquierda del elemento) sobre el `boundingRect`.
  4. Toma la captura (`page.screenshot`, viewport completo, PNG).
  5. Remueve el overlay.
  6. Emite el paso a la GUI por IPC.
- Inputs de texto: consolidar en UN paso por campo (valor final), no un paso por tecla. Los campos de contraseña registran la acción pero guardan el valor como `"***"`.

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

Layout: viewport a la izquierda (flexible, ~70%), panel derecho fijo (mín. 420px).

**Barra superior de sesión:** campos módulo/funcionalidad/título/rol, URL base + botón "Abrir", selector de carpeta de salida, botón "Proyectos…" (abre el explorador de repositorios), indicador de estado (Listo / Grabando / Pausado).

**Controles:** ● Grabar, ⏸ Pausar, ■ Detener y guardar. Atajo global `Ctrl+Shift+R` para pausar/reanudar sin tocar el panel.

**Panel de pasos:** lista scrolleable de tarjetas. Cada tarjeta: miniatura clicable (abre la captura a tamaño real en modal), badge de número, título (input), descripción (textarea auto-resize), chip con el selector preferido y su estrategia, toggle "incluir en docs", botones eliminar y arrastrar para reordenar (dnd-kit). Al llegar un paso nuevo durante la grabación, hacer scroll automático y enfocar el campo título para escribir la descripción al vuelo.

**Validación al guardar:** avisar si hay pasos sin título; permitir guardar de todos modos.

**Sección Git** (dentro del panel, ver §10): aparece cuando la carpeta de salida está dentro de un repositorio. Casilla "Registrar en Git al guardar", campos de rama y mensaje (prerrellenados a partir de los metadatos), casilla de push (deshabilitada si no hay remoto `origin`), y avisos: de qué rama nacerá la nueva, cambios sin guardar que impedirían el cambio de rama, o archivos ajenos ya indexados. Cuando la carpeta **no** está en un repositorio, la sección lo explica en vez de desaparecer sin más.

**Explorador de repositorios** (modal "Proyectos…"): tres columnas — repositorios ya usados → ramas → historial de commits — de **solo lectura** sobre el repositorio. Permite dos acciones: usar otro proyecto para la sesión (cambia la carpeta de salida) y elegir la rama base de la próxima grabación. "Quitar de la lista" solo olvida la entrada del registro; no toca el repositorio en disco.

**Centro de ayuda** (botón "?"): modal con navegación de temas a la izquierda y contenido desplazable a la derecha (con resaltado del tema activo al desplazar). Documenta el uso, cada control, la integración con Git y con Docusaurus, y la solución de problemas.

**Aviso inicial de Docusaurus**: al arrancar se muestra un modal con lo esencial para que la documentación se vea en Docusaurus (elegir `docs/`, cambiar de rama para previsualizar). Incluye "No volver a mostrar" (persistido en `localStorage`) y es reabrible desde la ayuda.

**Aviso de raíz de Docusaurus**: si la carpeta de salida es la raíz de un proyecto Docusaurus (tiene `docusaurus.config.*` y una carpeta `docs/`), una franja avisa de que la documentación no se renderizaría ahí, con un atajo para cambiar a `docs/`. Es el error más común (§10).

**Estado inicial**: mientras no hay página cargada, la vista nativa se mantiene oculta y el hueco del visor muestra un onboarding (qué es la app y los tres pasos para empezar), en vez de un `about:blank` vacío.

**Modales y vista nativa**: el `WebContentsView` siempre se pinta sobre el HTML, así que cualquier superposición propia (diálogos, explorador, ayuda) oculta la vista nativa mientras está abierta.

Diseño limpio, denso en información, con **modo claro y oscuro** (interruptor en la barra; preferencia persistida, por defecto la del sistema); tipografía del sistema. Sin librerías UI pesadas (CSS propio con tokens de tema).

## 9. Seguridad y calidad

- `contextIsolation: true`, `nodeIntegration: false` en todos los renderers; IPC solo por `contextBridge` con canales tipados (definir un archivo `ipc-contract.ts` compartido).
- El viewport del sistema web NO recibe acceso a APIs de Node.
- No persistir credenciales; la sesión del sistema vive en la partición del `WebContentsView` (usar `session.fromPartition('persist:target-app')` para conservar login entre usos).
- TypeScript estricto. ESLint + Prettier.
- Estructura de código: `src/main/` (main + engine), `src/preload/`, `src/renderer/`, `src/shared/` (tipos y contrato IPC).

## 10. Integración Git (GitHub Flow)

La documentación se registra en el repositorio Docusaurus **clonado** por quien documenta (§1). El objetivo es que cada funcionalidad documentada produzca una rama y un PR independientes, siguiendo GitHub Flow.

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

## 12. Sugerencia de plan de implementación (para el agente)

1. Scaffold electron-vite + React + TS, ventana con layout dividido y `WebContentsView` navegable.
2. Conexión CDP: lanzar con remote debugging, adjuntar Playwright al target del viewport, verificar `page.title()`.
3. Observador inyectado + IPC del evento crudo hasta la GUI (sin captura aún).
4. Generación de selectores + espera de estabilidad + captura con overlay.
5. Panel de tarjetas completo (edición, reorden, eliminación).
6. Guardado a disco + renombrado de imágenes + validaciones.
7. Pruebas manuales contra un sitio Next.js real; ajustar esperas y portales.
