# DocRecorder

Grabador de documentación paso a paso para sistemas web de los que solo se tiene
acceso como usuario. Se abre el sistema en un viewport embebido, se navega con
normalidad y cada interacción se convierte en una tarjeta con captura resaltada,
selectores robustos y textos editables. Al detener, se exporta un paquete
portable a disco.

Implementación del MVP descrito en [`SPEC.md`](./SPEC.md), más la fase de integración
con Git.

## Uso

```bash
npm install
npm run dev      # desarrollo con recarga en caliente
npm run build    # typecheck + compilación a out/
npm start        # ejecuta lo compilado
```

Flujo de trabajo:

1. Rellena **módulo**, **funcionalidad**, **título** y **rol** en la barra superior.
2. Escribe la **URL base** y pulsa **Abrir**. Inicia sesión dentro del viewport si hace
   falta: la sesión se conserva entre usos (partición `persist:target-app`).
3. Elige la **carpeta de salida** (el campo también acepta una ruta pegada).
4. Pulsa **●** y navega. Cada clic, campo rellenado, selección y envío genera una tarjeta.
   `Ctrl+Shift+R` pausa y reanuda sin salir del sistema documentado.
5. Edita títulos y descripciones, reordena arrastrando y elimina lo que sobre.
6. Pulsa **■** para detener y guardar.

Salida:

```
<carpeta>/<module>/<feature>/
  ├── session.json   # sesión completa con textos y capturas
  ├── flow.json      # solo acciones + selectores (insumo del runner futuro)
  └── img/paso-01.png …
```

## Arquitectura

```
src/
  main/            proceso principal
    index.ts       ventana, IPC, protocolo docshot:, atajo global
    viewport.ts    WebContentsView del sistema documentado
    storage.ts     escritura del paquete en disco
    engine/
      cdp.ts       conexión Playwright ↔ viewport por CDP
      observer.ts  script inyectado en la página documentada
      selectors.ts ranking y puntuación de selectores
      stability.ts espera de estabilidad del DOM antes de capturar
      recorder.ts  orquestación: cola de eventos → paso documentado
  preload/         contextBridge con canales tipados
  renderer/        GUI React
  shared/          tipos y contrato IPC comunes
```

### Cómo se conecta Playwright al viewport

Electron arranca con `--remote-debugging-port=9333`, y el motor usa
`chromium.connectOverCDP()`. Dos detalles que cuestan encontrar:

- **El `WebContentsView` debe tener algo cargado antes de conectar.** Una vista que
  nunca cargó nada no tiene proceso renderer: su target CDP acepta la conexión pero
  no responde a ningún comando, y `connectOverCDP` se cuelga esperando a que todas
  las páginas se inicialicen. Por eso la vista carga `about:blank` al crearse.
- **Los ids de target de CDP no se corresponden con los `webContents.id` de Electron.**
  Para saber cuál de los targets es el viewport se planta un marcador único desde
  el lado Electron y se busca desde el lado Playwright la página que lo ve.

La app usa bloqueo de instancia única: dos instancias competirían por el puerto de
depuración y la segunda se quedaría sin poder grabar, sin síntoma visible.

### Selectores

Por cada paso se guardan todos los candidatos ordenados por robustez estimada, para
que el runner futuro pueda hacer fallback: `data-testid` → `id` (descartando los
autogenerados tipo `:r1:`, `radix-…` o uuid) → rol ARIA + nombre accesible →
texto visible → CSS estructural corto. Ninguna estrategia se apoya en clases
hasheadas de CSS Modules ni en cadenas de utilidades Tailwind.

Cuando el clic aterriza en un `<img>` o `<span>` decorativo dentro de un control, se
sube al control que lo contiene: es lo que describe el paso y lo que da un selector
estable.

## Integración con el repositorio de documentación

Si la carpeta de salida está dentro de un repositorio Git, el panel ofrece registrar el resultado automáticamente: crea (o reutiliza) una rama `docs/<modulo>-<funcionalidad>`, hace commit con un mensaje semántico y, si se pide expresamente, sube la rama a `origin`.

Se invoca el `git` del sistema en vez de embeber una implementación, para respetar la configuración, las credenciales y los hooks que ya tenga esa persona.

Como escribe en un repositorio ajeno, las salvaguardas son parte del contrato:

- **Solo se indexan las rutas que escribe DocRecorder.** Nunca `git add -A`, que barrería trabajo en curso hacia nuestro commit.
- **Se aborta si hay cambios ajenos ya indexados**, porque acabarían dentro del commit.
- **No se cambia de rama si hay archivos seguidos modificados**, que viajarían a la rama nueva. Los archivos sin seguimiento no bloquean: Git los conserva intactos al hacer checkout.
- **El push nunca es automático** y jamás usa `--force`.
- **Si el commit falla, el paquete en disco se conserva.** Perder una grabación por un problema del repositorio sería mucho peor que quedarse sin commit; el error se muestra y la grabación sigue ahí.

Tres detalles de implementación que costaron encontrar y que conviene no revertir:

- `git status` se lee con `-z` y `--untracked-files=all`. Sin `-z`, Git escapa entre comillas las rutas con acentos; sin `--untracked-files=all`, colapsa un directorio nuevo entero en una sola entrada (`?? carpeta/`) y las rutas propias dejan de coincidir. La salida tampoco se puede recortar: una entrada como `" M archivo"` empieza por espacio, y ese espacio es justo lo que distingue indexado de no indexado.
- Las rutas se resuelven con `realpath` antes de compararlas con la raíz del repositorio. En macOS `/var` es un enlace simbólico a `/private/var` y `git rev-parse --show-toplevel` siempre devuelve la ruta real, así que sin resolver ambas `git add` rechaza los archivos por quedar «fuera del repositorio».

## Pruebas

```bash
npm run build
node scripts/smoke.mjs        # 40 comprobaciones de extremo a extremo
node scripts/smoke-next.mjs   # contra un Next.js real (por defecto nextjs.org)
```

`scripts/smoke.mjs` levanta una página de prueba que reproduce los patrones
problemáticos de Next.js (clases hasheadas, modal en un portal con retraso,
navegación cliente sin cambio de URL, campo de contraseña), arranca la app, la maneja
por CDP como lo haría una persona y comprueba el paquete escrito en disco. La carpeta
de salida es un repositorio Git real, así que también ejercita la integración completa
y sus salvaguardas.

## Decisiones que se apartan de SPEC.md

- **React 19** en vez de 18: es la versión actual y no cambia nada del diseño.
- **La espera de estabilidad no es una carrera pura entre `networkidle` y silencio del
  DOM.** En una navegación cliente sin peticiones, `networkidle` ya está satisfecho y
  resolvería al instante — justo el problema que se quiere evitar. Ambas señales
  llevan un suelo de 300 ms, así que la red puede acortar la espera larga pero no
  saltársela.
- **El foco automático en el título del paso nuevo solo se toma si la GUI ya tenía el
  foco.** Robárselo al usuario mientras está dentro del sistema documentado rompería
  la grabación: lo que teclease acabaría en el panel en vez de en el formulario, y ese
  paso `fill` nunca se registraría.

## Fases pendientes

Generación de MDX para Docusaurus, runner headless de regeneración y asistencia de IA
para redactar descripciones. El modelo de datos y `flow.json` ya están pensados para ello.
