# Especificación técnica — MVP Grabador de Documentación ("DocRecorder")

## 1. Contexto y objetivo

Herramienta de escritorio para documentar paso a paso los módulos de un sistema web (frontend en **Next.js**, al cual NO se tiene acceso de código fuente — solo acceso como usuario vía navegador). La documentación final vivirá en un proyecto **Docusaurus** mantenido por otro desarrollador.

**Objetivo del MVP (esta etapa):** una app Electron donde el usuario:

1. Abre el sistema web en un viewport embebido.
2. Presiona "Grabar" y navega normalmente.
3. Cada interacción relevante genera automáticamente una **tarjeta de paso** en un panel lateral: captura de pantalla con el elemento resaltado + selector detectado + campo editable de título/descripción.
4. Puede editar, reordenar y eliminar pasos.
5. Al guardar, exporta un paquete portable a disco: `steps.json` + capturas PNG + un `flow.json` reproducible.

**Fuera de alcance del MVP** (etapas futuras, pero el diseño debe dejarlas fáciles):

- Integración Git (ramas, commits).
- Generación de MDX para Docusaurus.
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

## 7. Estructura de salida en disco

```
<carpeta-elegida>/
└── <module>/
    └── <feature>/
        ├── session.json      # DocSession completa
        ├── flow.json         # solo acciones + selectores (insumo del runner futuro)
        └── img/
            ├── paso-01.png
            ├── paso-02.png
            └── ...
```

Nomenclatura: kebab-case en carpetas, `paso-NN.png` con cero a la izquierda. Al reordenar pasos en la GUI, renombrar las imágenes al guardar para que el orden en disco siempre coincida.

## 8. GUI (renderer)

Layout: viewport a la izquierda (flexible, ~70%), panel derecho fijo (mín. 420px).

**Barra superior de sesión:** campos módulo/funcionalidad/título/rol, URL base + botón "Abrir", selector de carpeta de salida, indicador de estado (Listo / Grabando / Pausado).

**Controles:** ● Grabar, ⏸ Pausar, ■ Detener y guardar. Atajo global `Ctrl+Shift+R` para pausar/reanudar sin tocar el panel.

**Panel de pasos:** lista scrolleable de tarjetas. Cada tarjeta: miniatura clicable (abre la captura a tamaño real en modal), badge de número, título (input), descripción (textarea auto-resize), chip con el selector preferido y su estrategia, toggle "incluir en docs", botones eliminar y arrastrar para reordenar (dnd-kit). Al llegar un paso nuevo durante la grabación, hacer scroll automático y enfocar el campo título para escribir la descripción al vuelo.

**Validación al guardar:** avisar si hay pasos sin título; permitir guardar de todos modos.

Diseño limpio, denso en información, modo claro; tipografía del sistema. Sin librerías UI pesadas (CSS propio o Tailwind).

## 9. Seguridad y calidad

- `contextIsolation: true`, `nodeIntegration: false` en todos los renderers; IPC solo por `contextBridge` con canales tipados (definir un archivo `ipc-contract.ts` compartido).
- El viewport del sistema web NO recibe acceso a APIs de Node.
- No persistir credenciales; la sesión del sistema vive en la partición del `WebContentsView` (usar `session.fromPartition('persist:target-app')` para conservar login entre usos).
- TypeScript estricto. ESLint + Prettier.
- Estructura de código: `src/main/` (main + engine), `src/preload/`, `src/renderer/`, `src/shared/` (tipos y contrato IPC).

## 10. Criterios de aceptación del MVP

1. Puedo abrir cualquier URL (con login manual dentro del viewport) y la sesión persiste al reabrir la app.
2. Con la grabación activa, cada clic e input relevante genera una tarjeta con captura resaltada correcta (incluso en modales y tras navegación cliente de Next).
3. Los inputs de texto se consolidan en un solo paso; las contraseñas quedan enmascaradas.
4. Puedo editar título/descripción, reordenar y eliminar pasos antes de guardar.
5. Al detener, se escribe la estructura del §7 y las imágenes coinciden con el orden final.
6. Cada paso guarda ≥1 selector candidato que NO depende de clases CSS hasheadas.
7. La app corre en Windows y Linux (desarrollo principal en el SO del autor).

## 11. Sugerencia de plan de implementación (para el agente)

1. Scaffold electron-vite + React + TS, ventana con layout dividido y `WebContentsView` navegable.
2. Conexión CDP: lanzar con remote debugging, adjuntar Playwright al target del viewport, verificar `page.title()`.
3. Observador inyectado + IPC del evento crudo hasta la GUI (sin captura aún).
4. Generación de selectores + espera de estabilidad + captura con overlay.
5. Panel de tarjetas completo (edición, reorden, eliminación).
6. Guardado a disco + renombrado de imágenes + validaciones.
7. Pruebas manuales contra un sitio Next.js real; ajustar esperas y portales.
