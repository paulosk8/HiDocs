import { useEffect, useRef, useState } from 'react'
import { useSession } from '../store'

/**
 * Centro de ayuda de la aplicación.
 *
 * Patrón de centro de ayuda: navegación de temas a la izquierda y contenido
 * desplazable a la derecha, todo dentro del overlay ya establecido (como el
 * explorador de Proyectos). El tema activo se resalta según lo que hay a la
 * vista, para que el usuario no pierda el hilo en un documento largo.
 */

const SECTIONS = [
  { id: 'intro', label: '¿Qué es DocRecorder?' },
  { id: 'inicio', label: 'Primeros pasos' },
  { id: 'barra', label: 'Barra superior' },
  { id: 'grabar', label: 'Grabar pasos' },
  { id: 'pasos', label: 'Panel de pasos' },
  { id: 'estado', label: 'Estado del proyecto' },
  { id: 'rama', label: 'Rama de trabajo' },
  { id: 'git', label: 'Integración con Git' },
  { id: 'docusaurus', label: 'Salida y Docusaurus' },
  { id: 'proyectos', label: 'Explorador de proyectos' },
  { id: 'regenerar', label: 'Regenerar capturas' },
  { id: 'ia', label: 'Redactar con IA' },
  { id: 'interfaz', label: 'Panel y tema' },
  { id: 'atajos', label: 'Atajos y solución de problemas' }
]

export function HelpModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [active, setActive] = useState('intro')
  const contentRef = useRef<HTMLDivElement>(null)
  const openDocusaurusIntro = useSession((s) => s.openDocusaurusIntro)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Resalta el tema cuya sección está más arriba dentro del área visible.
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 }
    )
    root.querySelectorAll('[data-help-section]').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  const go = (id: string): void => {
    const el = contentRef.current?.querySelector(`#${id}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActive(id)
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="help-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Ayuda de DocRecorder</h2>
          <button onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </header>

        <div className="help-body">
          <nav className="help-nav" aria-label="Temas de ayuda">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={s.id === active ? 'active' : ''}
                onClick={() => go(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="help-content" ref={contentRef}>
            <section id="intro" data-help-section>
              <h3>¿Qué es DocRecorder?</h3>
              <p>
                DocRecorder documenta <b>paso a paso</b> los flujos de un sistema web al que solo
                tienes acceso como usuario (sin su código fuente). Abres el sistema en un visor
                integrado, grabas tu recorrido y cada interacción se convierte en un <b>paso</b> con
                su captura de pantalla, el elemento resaltado y un selector reutilizable.
              </p>
              <p>
                El resultado es un paquete portable (JSON + imágenes) más la página del manual en{' '}
                <b>MDX</b>, lista para que <b>Docusaurus</b> la renderice, y opcionalmente se
                registra en Git como una rama lista para abrir un Pull Request.
              </p>
              <p>
                Dos ayudas más, una vez grabado: la{' '}
                <a onClick={() => go('ia')}>redacción con IA</a> propone el título y la descripción
                de cada paso, y el <a onClick={() => go('regenerar')}>runner de regeneración</a>{' '}
                actualiza las capturas cuando el sistema documentado cambia de interfaz.
              </p>
            </section>

            <section id="inicio" data-help-section>
              <h3>Primeros pasos</h3>
              <ol className="help-steps">
                <li>
                  Rellena los metadatos de la parte superior: <b>Módulo</b>, <b>Funcionalidad</b>,{' '}
                  <b>Título</b> y <b>Rol</b>.
                </li>
                <li>
                  Escribe la <b>URL</b> del sistema y pulsa <b>Abrir</b>. Inicia sesión con
                  normalidad si hace falta: la sesión se conserva entre usos.
                </li>
                <li>
                  Elige la <b>carpeta de salida</b>. Si está dentro de un repositorio Git, se
                  habilita la integración.
                </li>
                <li>
                  Pulsa <b>● Grabar</b> y navega. Revisa y edita los pasos en el panel derecho.
                </li>
                <li>
                  Pulsa <b>■ Detener y guardar</b>. Se escribe el paquete en disco y, si lo
                  activaste, se registra en Git.
                </li>
              </ol>
              <p>
                <b>¿Continuando algo ya empezado?</b> Empieza por el final: elige la{' '}
                <a onClick={() => go('rama')}>rama de trabajo</a> en la franja de estado y los
                metadatos con los que se documentó esa rama se rellenan solos.
              </p>
            </section>

            <section id="barra" data-help-section>
              <h3>Barra superior</h3>
              <p>
                Los cuatro campos de metadatos alimentan tanto la organización en disco como las
                sugerencias de Git (ver <a onClick={() => go('git')}>Integración con Git</a>):
              </p>
              <ul className="help-defs">
                <li>
                  <b>Módulo</b> · agrupa funcionalidades (p. ej. <code>matriculas</code>). Define la
                  carpeta y el ámbito del commit.
                </li>
                <li>
                  <b>Funcionalidad</b> · el flujo concreto (p. ej. <code>crear-matricula</code>).
                </li>
                <li>
                  <b>Título</b> · texto legible que encabeza la guía y el mensaje de commit.
                </li>
                <li>
                  <b>Rol</b> · el perfil de usuario con el que se ejecuta el flujo.
                </li>
              </ul>
              <p>Controles de la barra:</p>
              <ul className="help-defs">
                <li>
                  <b>‹ › ↻</b> · atrás, adelante y recargar en el visor.
                </li>
                <li>
                  <b>URL base</b> + <b>Abrir</b> · carga el sistema en el visor.
                </li>
                <li>
                  <b>Carpeta de salida</b> + <b>Elegir…</b> · dónde se guarda el paquete. Puede ser
                  una subcarpeta del repositorio.
                </li>
                <li>
                  <b>Proyectos…</b> · abre el explorador de repositorios ya usados.
                </li>
                <li>
                  <b>Regenerar…</b> · actualiza las capturas de una funcionalidad ya documentada
                  (ver <a onClick={() => go('regenerar')}>Regenerar capturas</a>).
                </li>
                <li>
                  <b>IA</b> · ajustes de la redacción con IA; muestra <b>✓</b> cuando hay clave
                  configurada (ver <a onClick={() => go('ia')}>Redactar con IA</a>).
                </li>
                <li>
                  <b>☾ / ☀</b> · alterna el modo claro y oscuro.
                </li>
                <li>
                  <b>?</b> · abre esta ayuda.
                </li>
                <li>
                  <b>Indicador de estado</b> · Listo / Grabando / Pausado.
                </li>
              </ul>
            </section>

            <section id="grabar" data-help-section>
              <h3>Grabar pasos</h3>
              <p>Los tres controles del panel de pasos gobiernan la grabación:</p>
              <ul className="help-defs">
                <li>
                  <b>●</b> Grabar · empieza a capturar interacciones.
                </li>
                <li>
                  <b>⏸ / ▶</b> Pausar / Reanudar · detiene la captura sin cerrar la sesión.
                </li>
                <li>
                  <b>■</b> Detener y guardar · finaliza y escribe el paquete. Si falta algún dato
                  (módulo, funcionalidad o carpeta de salida) <b>detiene igualmente</b> y te dice
                  qué falta: complétalo arriba y vuelve a pulsarlo, tus pasos siguen ahí. Si Git
                  está activo, antes avisa de que se registrará en Git (con la rama), para que
                  puedas <b>cancelar y seguir grabando</b> si aún no está completo.
                </li>
              </ul>
              <p>
                Durante la grabación, cada clic, escritura, selección o envío relevante genera un
                paso. La app espera a que la página se estabilice, resalta el elemento y toma la
                captura. Si para entonces algo ha quedado encima —el fondo oscuro de un modal
                recién abierto, típicamente— el recuadro le devuelve el brillo, para que el
                elemento que el paso señala se siga viendo. Y si el clic <b>cambia de pantalla</b>{' '}
                (cerrar sesión, un enlace), se conserva la captura tomada justo antes, que sí
                muestra dónde pulsaste, en vez de la pantalla siguiente. Lo mismo con los{' '}
                <b>menús que se cierran</b> al elegir una opción: como se desvanecen poco a poco, se
                documenta la captura previa, con el menú aún legible, en vez de una medio borrada.
                Los campos de texto se consolidan en <b>un solo paso</b> (el valor final), y las{' '}
                <b>contraseñas se enmascaran</b> como <code>***</code>.
              </p>
              <p>
                <b>Botones que abren su menú al presionar</b> (los de las librerías actuales) se
                registran igual: aunque la capa que montan encima se quede con el gesto y el botón
                nunca llegue a recibir el clic, el paso se documenta con el nombre del botón que
                pulsaste.
              </p>
              <p>
                <b>Agrupar campos</b> (interruptor en el encabezado del panel, activado por
                defecto): une los campos seguidos de un mismo formulario en <b>un solo paso</b> —una
                captura del formulario relleno y la lista de campos y valores— en vez de una captura
                por campo. Desactívalo si prefieres documentar cada campo por separado.
              </p>
              <ul className="help-defs">
                <li>
                  <b>Qué entra en el grupo</b> · escribir, elegir de una lista, marcar una casilla o
                  accionar un <b>interruptor</b>, y también los <b>clics en un campo</b> (enfocarlo
                  antes de escribir). Se reconocen tanto los campos clásicos como los construidos a
                  mano, que es lo habitual hoy: un interruptor puede ser un botón con rol{' '}
                  <code>switch</code>, o un texto con la casilla real escondida al lado. Un botón,
                  un enlace o una pestaña nunca cuentan como campo aunque estén junto a uno.
                </li>
                <li>
                  <b>Un gesto, un paso</b> · esos controles suelen reenviar el clic a la casilla que
                  esconden, lo que generaría dos o tres pasos para lo que tú viviste como uno. Se
                  documenta solo el que pulsaste y se descartan los reenvíos.
                </li>
                <li>
                  <b>Qué lo cierra</b> · un clic en un botón, un envío o una navegación. Lo que
                  venga después empieza un grupo nuevo, aunque sea del mismo formulario.
                </li>
                <li>
                  <b>Las tablas no se agrupan</b> · marcar la casilla o el interruptor de{' '}
                  <b>dos filas</b> son dos acciones sobre dos registros, no un formulario que se
                  rellena, así que cada una es su propio paso. Dentro de una misma fila sí se
                  agrupan (edición en línea).
                </li>
                <li>
                  <b>La captura</b> · resalta en rojo <b>todos</b> los campos del grupo, y se
                  rehace cada vez que el grupo cambia.
                </li>
                <li>
                  <b>Revisar y depurar</b> · la tarjeta lista los campos con su valor; el <b>✕</b>{' '}
                  de cada uno lo quita del paso (y del flujo reproducible). No se puede vaciar el
                  grupo entero: para eso está eliminar el paso.
                </li>
              </ul>
              <p>
                <b>Continuar otro día:</b> la grabación en curso se <b>autoguarda</b> como borrador.
                Puedes cerrar la app y, al volver a abrirla, te ofrecerá{' '}
                <b>continuar donde lo dejaste</b> o descartarlo. El borrador se descarta al
                finalizar y registrar en Git.
              </p>
            </section>

            <section id="pasos" data-help-section>
              <h3>Panel de pasos</h3>
              <p>Cada tarjeta representa un paso y es editable antes de guardar:</p>
              <ul className="help-defs">
                <li>
                  <b>Miniatura</b> · clic para ver la captura a tamaño real.
                </li>
                <li>
                  <b>Número</b> · el orden del paso; se renumera al reordenar.
                </li>
                <li>
                  <b>Título y descripción</b> · edítalos para explicar el paso.
                </li>
                <li>
                  <b>✨</b> · propone título y descripción para ese paso con IA (ver{' '}
                  <a onClick={() => go('ia')}>Redactar con IA</a>).
                </li>
                <li>
                  <b>Selector</b> · la estrategia detectada (test-id, rol, texto…) para reproducir
                  el paso más adelante.
                </li>
                <li>
                  <b>Incluir en docs</b> · desmárcalo para conservar un paso de navegación sin
                  publicarlo.
                </li>
                <li>
                  <b>Arrastrar</b> para reordenar, <b>eliminar</b> para descartar.
                </li>
              </ul>
              <p>
                <b>Escribir los textos</b> · el título y la descripción se publican tal cual en el
                manual, así que llevan <b>corrector ortográfico</b>: las palabras dudosas aparecen
                subrayadas. Con el <b>clic derecho</b> sobre una de ellas salen las sugerencias, la
                opción de <b>añadirla al diccionario</b> (útil con nombres propios y siglas del
                sistema que documentas) y cortar, copiar, pegar y seleccionar todo.
              </p>
              <p>En el encabezado del panel:</p>
              <ul className="help-defs">
                <li>
                  <b>agrupar campos</b> · une los campos seguidos de un mismo formulario (escribir,
                  elegir, marcar un interruptor) en un solo paso, con una sola captura en la que se
                  resaltan <b>todos</b> los campos del grupo. Un clic en un botón, un envío o una
                  navegación cierran el grupo. Cada campo se lista en la tarjeta y puedes{' '}
                  <b>quitarlo</b> con su ✕ si no quieres documentarlo.
                </li>
                <li>
                  <b>✨ Redactar todos</b> · redacta de una vez todos los pasos marcados como
                  <b> incluir en docs</b>.
                </li>
                <li>
                  <b>● ⏸ ■</b> · grabar, pausar/reanudar y detener para guardar.
                </li>
              </ul>
              <p>
                El panel se puede <b>colapsar</b> (ver{' '}
                <a onClick={() => go('interfaz')}>Panel y tema</a>) para dar todo el ancho al visor.
              </p>
            </section>

            <section id="estado" data-help-section>
              <h3>Estado del proyecto</h3>
              <p>
                La franja bajo la barra superior resume, siempre visible, el repositorio de la
                sesión: nombre, <b>rama de trabajo</b> (donde irá el commit, y desde donde se elige
                otra: ver <a onClick={() => go('rama')}>Rama de trabajo</a>), si esa rama aún no
                existe y de cuál nacerá, si hay cambios pendientes (verde = limpio, ámbar =
                pendientes) y cuántos proyectos hay registrados. Si la carpeta no está en un
                repositorio, lo indica.
              </p>
            </section>

            <section id="rama" data-help-section>
              <h3>Rama de trabajo</h3>
              <p>
                La rama de trabajo es <b>dónde se registrará lo que grabes</b>. Se muestra en la
                franja de estado y al pulsarla se despliega el selector, que sirve para las dos
                cosas del día a día: <b>seguir en una rama que ya empezaste</b> o <b>estrenar una</b>
                .
              </p>
              <ul className="help-defs">
                <li>
                  <b>Continuar en una rama</b> · elígela de la lista. La app lee la documentación
                  que esa rama ya tiene commiteada y <b>rellena por ti</b> el módulo, el rol y la URL
                  base con los que se venía trabajando: no hay que volver a escribir la cabecera
                  para acabar donde ya estabas. Solo se rellena lo que esté vacío; lo que tú
                  escribas manda siempre.
                </li>
                <li>
                  <b>Retomar una funcionalidad concreta</b> · bajo la lista aparecen las guías que
                  esa rama ya documenta. Pulsar una carga sus cuatro campos exactos, que es lo que
                  necesitas para ampliarla o volver a grabarla (si no, la salida caería en otra
                  carpeta).
                </li>
                <li>
                  <b>Rama nueva</b> · escribe el nombre (se propone <code>docs/&lt;módulo&gt;</code>)
                  y elige de qué rama <b>nace</b>. Si el nombre ya existe, se te avisa: el commit se
                  añadirá encima en vez de crear nada.
                </li>
              </ul>
              <p>
                <b>Elegir aquí no hace checkout.</b> El cambio de rama —o su creación— ocurre al
                guardar, con las salvaguardas de siempre: si hay cambios ajenos sin guardar que se
                arrastrarían, el commit se aborta y te lo dice.
              </p>
              <p>
                Al <b>abrir la app</b>, si el repositorio quedó en una rama de documentación, se
                retoma sola con sus metadatos (sin activar el registro en Git: eso lo decides tú).
                La misma rama se puede elegir desde el campo <b>Rama</b> de la sección Git y desde el
                explorador de <a onClick={() => go('proyectos')}>Proyectos</a>: los tres sitios
                escriben la misma rama de trabajo.
              </p>
            </section>

            <section id="git" data-help-section>
              <h3>Integración con Git (GitHub Flow)</h3>
              <p>
                Al guardar con <b>«Registrar en Git al guardar»</b> activo, la documentación se
                comitea en el repositorio que contiene la carpeta de salida. Cada funcionalidad
                genera su propia rama, pensada para un Pull Request independiente.
              </p>
              <ul className="help-defs">
                <li>
                  <b>Rama</b> · se sugiere <code>docs/&lt;módulo&gt;</code>, una por módulo: todas
                  las funcionalidades del mismo módulo se acumulan en su rama (un PR por módulo).
                  Puedes escribir otra aquí o elegirla en el selector de la franja superior (ver{' '}
                  <a onClick={() => go('rama')}>Rama de trabajo</a>); es el mismo dato. La nota de
                  debajo dice si esa rama ya existe (el commit se añade encima) o si va a nacer, y
                  de dónde.
                </li>
                <li>
                  <b>Mensaje del commit</b> · se sugiere{' '}
                  <code>docs(&lt;módulo&gt;): &lt;título&gt;</code>, distinto por funcionalidad.
                </li>
                <li>
                  <b>Rama base</b> · las ramas nacen de la rama por defecto del repositorio (
                  <code>main</code>), no de la anterior. La base solo interviene al <b>crear</b> una
                  rama, y se elige en el selector de rama, junto al nombre de la rama nueva.
                </li>
                <li>
                  <b>Push</b> · opcional y solo si hay remoto <code>origin</code>; nunca con{' '}
                  <code>--force</code>.
                </li>
              </ul>
              <p>
                Salvaguardas, porque se escribe en un repositorio que mantiene otra persona: solo se
                indexan los archivos que escribe DocRecorder (nunca <code>git add -A</code>), no se
                cambia de rama arrastrando cambios ajenos, y todo ocurre en local (sin clonar ni
                crear repositorios).
              </p>
            </section>

            <section id="docusaurus" data-help-section>
              <h3>Salida en disco e integración con Docusaurus</h3>
              <p>Cada grabación produce esta estructura dentro de la carpeta de salida:</p>
              <pre className="help-tree">
                {`<carpeta-de-salida>/   (idealmente la carpeta docs/ de Docusaurus)
└── <módulo>/
    ├── _category_.json    (etiqueta del módulo en la barra lateral)
    └── <funcionalidad>/
        ├── index.mdx      (la página del manual que Docusaurus muestra)
        ├── session.json   (la sesión completa)
        ├── flow.json      (acciones + selectores)
        └── img/paso-01.png …`}
              </pre>
              <p>
                La página <b>index.mdx</b> es el manual ya listo para Docusaurus: título, un
                apartado numerado por paso (que alimenta el índice lateral) y su captura. Los pasos
                sin «incluir en docs» se omiten. Los <code>.json</code> conviven sin estorbar:
                Docusaurus solo renderiza <code>.md</code> / <code>.mdx</code>.
              </p>
              <p>
                Flujo completo: el repositorio de documentación <b>ya existe</b> y lo mantiene otra
                persona. Lo <b>clonas</b>, eliges como carpeta de salida la carpeta{' '}
                <code>docs/</code> (o una subcarpeta) de ese clon, y al guardar se crea una rama con
                el manual. Para <b>ver cómo va quedando</b>, arranca Docusaurus en el repositorio (
                <code>npm run start</code>) y navega a la página; o abre un Pull Request para que
                esa persona lo integre. DocRecorder no crea ni clona repositorios: solo detecta el
                que ya contiene la carpeta.
              </p>
              <p>
                <a
                  onClick={() => {
                    onClose()
                    openDocusaurusIntro()
                  }}
                >
                  Volver a ver el aviso de inicio
                </a>
              </p>
            </section>

            <section id="proyectos" data-help-section>
              <h3>Explorador de proyectos</h3>
              <p>
                El botón <b>Proyectos…</b> abre un explorador de tres columnas —repositorios → ramas
                → historial— de <b>solo lectura</b>: no hace checkout, no crea ramas ni toca el
                historial. Un repositorio aparece aquí al comitear con éxito por primera vez. Desde
                él puedes:
              </p>
              <ul className="help-defs">
                <li>Volver a un repositorio usado sin buscar la carpeta en el disco.</li>
                <li>Ver las ramas y el historial de commits de cada una.</li>
                <li>
                  <b>Trabajar en una rama</b> del repositorio de la sesión: hace lo mismo que el
                  selector de la franja superior (ver{' '}
                  <a onClick={() => go('rama')}>Rama de trabajo</a>), recuperando también sus
                  metadatos.
                </li>
                <li>
                  <b>Pulsar un commit del historial</b> para ver, dentro de la app, la documentación
                  que registró (pasos y capturas), leída de Git sin arrancar Docusaurus ni hacer
                  checkout. Útil para revisar hasta dónde llegaste en una rama.
                </li>
                <li>
                  «Quitar de la lista» olvida la entrada del registro, sin tocar el repositorio en
                  disco.
                </li>
              </ul>
            </section>

            <section id="regenerar" data-help-section>
              <h3>Regenerar capturas</h3>
              <p>
                Cuando el sistema documentado <b>cambia de interfaz</b>, sus capturas quedan
                desactualizadas. En vez de volver a grabar, el botón <b>Regenerar…</b> re-ejecuta el
                flujo de una funcionalidad y actualiza sus capturas:
              </p>
              <ol className="help-steps">
                <li>
                  Abre el sistema en el visor e <b>inicia sesión</b> (el runner reutiliza esa
                  sesión).
                </li>
                <li>
                  Pulsa <b>Regenerar…</b> y elige la carpeta de la funcionalidad (la que contiene su{' '}
                  <code>session.json</code>).
                </li>
                <li>
                  El runner reproduce cada paso en el visor y vuelve a capturar. Localiza los
                  elementos por sus selectores, con <b>fallback</b> a los alternativos.
                </li>
              </ol>
              <p>
                Si un paso ya no encuentra su elemento, se <b>marca como fallido</b> (conserva su
                captura anterior) y el runner sigue con el resto. Al final, un informe indica qué
                pasos se actualizaron y cuáles hay que revisar. Las capturas se sobrescriben en
                disco; tú revisas y comiteas con el flujo de Git normal.
              </p>
            </section>

            <section id="ia" data-help-section>
              <h3>Redactar con IA</h3>
              <p>
                El motor titula cada paso de forma mecánica (<i>Clic en «Guardar»</i>) y deja la
                descripción vacía. La <b>redacción con IA</b> propone un título y una descripción
                mejores a partir de la acción grabada, del valor introducido y —si lo permites— de
                la <b>captura</b> del paso, que es lo que le da el contexto de la pantalla.
              </p>
              <ol className="help-steps">
                <li>
                  Pulsa <b>IA…</b> en la barra superior, elige proveedor (<b>Claude</b> de Anthropic
                  o <b>Gemini</b> de Google) y pega tu clave de la API.
                </li>
                <li>
                  Redacta un paso suelto con el botón <b>✨</b> de su tarjeta, o todos de golpe con{' '}
                  <b>✨ Redactar todos</b> en el encabezado del panel.
                </li>
                <li>
                  Revisa y edita: la propuesta se escribe en los mismos campos de siempre y no se
                  guarda en la documentación hasta que pulsas <b>Detener y guardar</b>.
                </li>
              </ol>
              <p>
                <b>Dónde va la clave</b> · se guarda cifrada por el sistema operativo en la carpeta
                de datos de la aplicación, nunca en el repositorio de documentación, y no sale del
                proceso principal: la llamada a la API se hace ahí, como las de Git.
              </p>
              <p>
                <b>Coste</b> · cada llamada se factura en tu cuenta del proveedor. Los pasos se
                envían en lotes pequeños para que el flujo completo dé contexto sin repetirlo en
                cada paso. Si quieres abaratar, desmarca <b>Enviar también la captura</b>: el modelo
                recibirá solo la acción, el elemento y el valor. Solo se redactan los pasos marcados
                como <b>incluir en docs</b>.
              </p>
              <p>
                <b>Privacidad</b> · con la captura activada, la pantalla del sistema que documentas
                (con sus datos de prueba) se envía al proveedor. Si documentas con datos reales,
                desactívala. Las contraseñas ya viajan enmascaradas como <code>***</code>.
              </p>
            </section>

            <section id="interfaz" data-help-section>
              <h3>Panel de pasos y tema</h3>
              <p>
                <b>Colapsar el panel</b> (botón <b>»</b> del encabezado, o <b>«</b> en la tira) lo
                reduce a una tira estrecha con los controles de grabación. El visor recupera el
                ancho completo, útil cuando la página que documentas oculta su menú lateral por
                falta de espacio.
              </p>
              <p>
                <b>Modo oscuro</b> · el botón <b>☾ / ☀</b> alterna el tema; la elección se recuerda
                para el próximo arranque. La primera vez se respeta el tema del sistema operativo.
              </p>
            </section>

            <section id="atajos" data-help-section>
              <h3>Atajos y solución de problemas</h3>
              <ul className="help-defs">
                <li>
                  <b>Ctrl/Cmd + Shift + R</b> · pausar o reanudar la grabación sin volver al panel.
                </li>
                <li>
                  <b>Esc</b> · cerrar esta ayuda, el explorador o un diálogo abierto.
                </li>
              </ul>
              <p>Si algo no va como esperas:</p>
              <ul className="help-defs">
                <li>
                  <b>No aparece la integración Git</b> · la carpeta de salida no está dentro de un
                  repositorio. Elige una carpeta dentro del clon del repositorio de documentación.
                </li>
                <li>
                  <b>El commit se aborta por cambios ajenos</b> · el repositorio tiene archivos
                  indexados que no son de DocRecorder. Haz commit o guárdalos en un stash y
                  reintenta.
                </li>
                <li>
                  <b>El push falla</b> · el commit local queda hecho igualmente; revisa el remoto y
                  las credenciales.
                </li>
                <li>
                  <b>Un campo del formulario no se agrupó</b> · algo cerró el grupo justo antes: un
                  clic en un botón, un envío o un cambio de pantalla —o los dos campos están en{' '}
                  <b>filas distintas</b> de una tabla, que nunca se agrupan—. Lo que viene después
                  empieza un grupo nuevo. Puedes documentarlo aparte o volver a grabar ese tramo
                  seguido.
                </li>
                <li>
                  <b>El corrector no subraya nada</b> · usa el diccionario del sistema operativo.
                  Comprueba que tienes el español instalado en las preferencias de idioma del
                  sistema.
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
