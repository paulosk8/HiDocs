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
  { id: 'agrupar', label: 'Agrupar pasos' },
  { id: 'carpetas', label: 'Carpetas de capturas' },
  { id: 'secciones', label: 'Secciones' },
  { id: 'captura', label: 'Capturas externas' },
  { id: 'pegar', label: 'Pegar imágenes y tablas' },
  { id: 'contenido', label: 'Bloques de contenido' },
  { id: 'notas', label: 'Notas destacadas' },
  { id: 'estado', label: 'Estado del proyecto' },
  { id: 'rama', label: 'Rama de trabajo' },
  { id: 'git', label: 'Integración con Git' },
  { id: 'pendiente', label: 'Documentación sin registrar' },
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
                Dos ayudas más, una vez grabado: la <a onClick={() => go('ia')}>redacción con IA</a>{' '}
                propone el título y la descripción de cada paso, y el{' '}
                <a onClick={() => go('regenerar')}>runner de regeneración</a> actualiza las capturas
                cuando el sistema documentado cambia de interfaz.
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
                  carpeta y el ámbito del commit; es la categoría del sidebar de Docusaurus.
                </li>
                <li>
                  <b>Subcategoría</b> (opcional) · un nivel intermedio entre módulo y funcionalidad
                  (p. ej. <code>administracion</code> → <code>institucion</code> →{' '}
                  <code>registrar-institucion</code>). Déjala vacía para la estructura de dos
                  niveles de siempre; al elegir la rama puedes verlas en árbol y colocar ahí el
                  nuevo proceso (ver <a onClick={() => go('rama')}>Rama de trabajo</a>).
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
                captura. Si para entonces algo ha quedado encima —el fondo oscuro de un modal recién
                abierto, típicamente— el recuadro le devuelve el brillo, para que el elemento que el
                paso señala se siga viendo. Y si el clic <b>cambia de pantalla</b> (cerrar sesión,
                un enlace), se conserva la captura tomada justo antes, que sí muestra dónde
                pulsaste, en vez de la pantalla siguiente. Lo mismo con los{' '}
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
                  <b>Qué lo cierra</b> · cambiar de tipo de control (un botón, una pestaña), un
                  envío, una tecla o una navegación. Lo que venga después empieza un paso nuevo,
                  aunque sea del mismo formulario.
                </li>
                <li>
                  <b>En una tabla manda dónde está</b> · se funden los controles de una{' '}
                  <b>misma fila</b> (edición en línea) y los de una <b>misma columna</b> en varias
                  filas (marcar la casilla de cinco alumnos es un paso). Dos controles distintos de
                  filas distintas no: ni son la misma acción ni el mismo registro. Ver{' '}
                  <a onClick={() => go('agrupar')}>Agrupar pasos</a>.
                </li>
                <li>
                  <b>La captura</b> · resalta en rojo <b>todos</b> los campos del grupo, y se rehace
                  cada vez que el grupo cambia.
                </li>
                <li>
                  <b>Revisar y depurar</b> · la tarjeta lista los campos con su valor; el <b>✕</b>{' '}
                  de cada uno lo quita del paso (y del flujo reproducible). No se puede vaciar el
                  grupo entero: para eso está eliminar el paso.
                </li>
              </ul>
              <p>
                <b>Dónde aparece cada paso:</b> detrás de la tarjeta en la que estés trabajando (la
                última que grabaste, o la última que tocaste). Grabando de corrido eso es el final
                de la lista, como siempre; pero si vuelves a un paso del medio porque te faltó algo,
                lo que grabes entra <b>ahí</b> y no al final. Es la misma regla que sigue{' '}
                <b>+ Añadir</b> y el pegado.
              </p>
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
                  <b>✂</b> · en las tarjetas cuya imagen es tuya (una captura externa o una imagen
                  pegada), recorta esa imagen o señala algo en ella (ver{' '}
                  <a onClick={() => go('pegar')}>Pegar imágenes y tablas</a>).
                </li>
                <li>
                  <b>▦</b> · añade un <b>bloque de contenido</b> (tabla, código, pestañas…) al paso
                  (ver <a onClick={() => go('contenido')}>Bloques de contenido</a>).
                </li>
                <li>
                  <b>📝</b> · añade una <b>nota destacada</b> al paso (ver{' '}
                  <a onClick={() => go('notas')}>Notas destacadas</a>).
                </li>
                <li>
                  <b>Casilla</b> · marca el paso para <b>agruparlo</b> con otros (ver{' '}
                  <a onClick={() => go('agrupar')}>Agrupar pasos</a>).
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
              <p>
                El encabezado tiene <b>dos filas</b>: arriba, la identidad del panel y los controles
                de grabación <b>● ⏸ ■</b> (grabar, pausar/reanudar y detener para guardar); debajo,
                lo que se hace con los pasos ya capturados:
              </p>
              <ul className="help-defs">
                <li>
                  <b>+ Añadir</b> · incorpora algo que no se graba: una{' '}
                  <a onClick={() => go('pegar')}>imagen del portapapeles</a>, una{' '}
                  <a onClick={() => go('captura')}>captura de pantalla externa</a>, un{' '}
                  <a onClick={() => go('contenido')}>bloque de contenido</a> o una{' '}
                  <a onClick={() => go('secciones')}>sección</a>. Lo añadido se coloca detrás de la
                  tarjeta en la que estés trabajando.
                </li>
                <li>
                  <b>✨ Redactar todos</b> · redacta de una vez todos los pasos marcados como
                  <b> incluir en docs</b>.
                </li>
                <li>
                  <b>agrupar seguidos</b> · une automáticamente los controles seguidos del mismo
                  tipo (los campos de un formulario, las casillas de una columna, las pestañas, los
                  botones). Ver <a onClick={() => go('agrupar')}>Agrupar pasos</a>.
                </li>
              </ul>
              <p>
                Al marcar la casilla de una tarjeta, esa segunda fila se convierte en la{' '}
                <b>barra de selección</b> (agrupar, eliminar y cancelar).
              </p>
              <p>
                El panel se puede <b>colapsar</b> (ver{' '}
                <a onClick={() => go('interfaz')}>Panel y tema</a>) para dar todo el ancho al visor.
              </p>
            </section>

            <section id="agrupar" data-help-section>
              <h3>Agrupar pasos</h3>
              <p>
                Un paso del manual no siempre es un clic. Rellenar un formulario, elegir una opción
                de un desplegable o marcar tres filas de una tabla son, para quien lee, <b>una</b>{' '}
                sola cosa. Agrupar une varios pasos grabados en uno solo: una captura, un título y
                la lista de lo que se hizo dentro.
              </p>
              <ul className="help-defs">
                <li>
                  <b>Automático, por tipo de control</b> · con <b>agrupar seguidos</b> marcado, se
                  funden en un paso los controles <b>seguidos del mismo tipo</b>: los <b>campos</b>{' '}
                  de un formulario (escribir, elegir en un desplegable o una lista, marcar una
                  casilla o un interruptor), varias <b>pestañas</b>, o varios <b>botones</b>{' '}
                  —incluido abrir un menú y elegir su opción, que es un solo paso para quien lee—.
                </li>
                <li>
                  <b>Al cambiar de tipo empieza un paso nuevo</b> · es lo que conserva el corte
                  natural del flujo: el <b>Guardar</b> de un formulario sigue teniendo su tarjeta, y
                  se une al formulario a mano si quieres. Un envío, una tecla y una navegación no se
                  funden nunca, y tampoco se funde nada a través de una recarga de la página.
                </li>
                <li>
                  <b>Dentro de una tabla</b> · manda dónde está el control. Se funden los de una{' '}
                  <b>misma fila</b> —un registro que se edita en línea— y los de una{' '}
                  <b>misma columna</b> en varias filas —marcar la casilla de cinco alumnos es un
                  paso, no cinco—, y el paso se titula con el encabezado de esa columna. No se
                  funden dos controles <b>distintos</b> de <b>filas distintas</b>: no son ni la
                  misma acción ni el mismo registro.
                </li>
                <li>
                  <b>A mano</b> · marca la <b>casilla</b> de cada tarjeta que quieras unir y pulsa{' '}
                  <b>⊞ Agrupar</b> en la barra de selección. Así se agrupa lo que el automático no
                  puede adivinar: botones, un selector con su opción, varias filas de una tabla o
                  una mezcla de todo.
                </li>
                <li>
                  <b>Deben ir seguidos</b> · el grupo se reproduce como una secuencia, así que solo
                  se agrupan pasos consecutivos. Si no lo están, arrástralos primero para ponerlos
                  juntos; la barra te dice el motivo cuando el botón no está disponible.
                </li>
                <li>
                  <b>El botón que cierra el formulario</b> · un botón no es un campo, así que
                  «Guardar» siempre da su propia tarjeta. Márcala junto a la del formulario y
                  agrúpalas: el paso queda como <i>Rellenar el formulario y pulsar «Guardar»</i>, y
                  la captura marca el botón y los campos. Igual funciona una fila de una tabla con
                  un botón de fuera de ella.
                </li>
                <li>
                  <b>La captura</b> · se vuelve a tomar señalando <b>todos</b> los elementos del
                  grupo a la vez, para que la imagen muestre lo que el paso describe. Los campos que
                  la aplicación haya vuelto a dibujar (al guardar, al recargar una tabla) se
                  localizan otra vez por su selector, así que siguen marcados. Si la pantalla ya es
                  otra, no se rehace: se conserva la captura que el paso traía, que sí muestra lo
                  que pasó.
                </li>
                <li>
                  <b>Si algo tapa un elemento</b> · con un desplegable o un menú abierto encima, el
                  motor espera un momento y vuelve a intentarlo, para no documentar campos que no se
                  ven. Bajo el fondo translúcido de un modal el recuadro le devuelve el brillo; bajo
                  un panel opaco no lo toca (aclararlo solo lavaba la imagen).
                </li>
                <li>
                  <b>⊟ Deshacer</b> · devuelve cada paso a su sitio con su captura original, también
                  en las fusiones automáticas. Si antes quitaste algún elemento del grupo con su ✕,
                  deja de ofrecerse.
                </li>
                <li>
                  <b>El título del grupo</b> · lo pone la app por lo que es («Rellenar el
                  formulario», «Marcar «Estado» en 3 filas», «Pulsar «Guardar» y «Cerrar»») y deja
                  de tocarlo en cuanto escribes el tuyo, aunque sigas grabando dentro de ese mismo
                  paso.
                </li>
              </ul>
              <p>
                Las <b>capturas externas</b>, las <b>imágenes pegadas</b>, los{' '}
                <b>bloques de contenido</b> y las <a onClick={() => go('secciones')}>secciones</a>{' '}
                no se agrupan: no son acciones del flujo y no hay nada que reproducir en ellos. Para
                juntar <i>capturas</i> —y no acciones— están las{' '}
                <a onClick={() => go('carpetas')}>carpetas de capturas</a>.
              </p>
            </section>

            <section id="carpetas" data-help-section>
              <h3>Carpetas de capturas</h3>
              <p>
                A veces un paso del manual necesita <b>varias imágenes</b>: las tres pantallas de un
                asistente, lo que se ve antes y después de guardar, o la pantalla del sistema junto
                al correo que llega. <a onClick={() => go('agrupar')}>Agrupar</a> no sirve para eso
                —funde acciones y deja <b>una</b> captura, y además exige pasos seguidos del flujo—.
                Una <b>carpeta</b> sí: es un paso del manual con todas sus capturas dentro.
              </p>
              <ul className="help-defs">
                <li>
                  <b>Crearla</b> · <b>+ Añadir → 📁 Carpeta de capturas</b>. Aparece vacía, con su
                  título y una zona donde soltar tarjetas.
                </li>
                <li>
                  <b>Llenarla</b> · <b>arrastra la tarjeta</b> por su asa (⠿) y suéltala{' '}
                  <b>dentro de la zona</b> de la carpeta. Vale cualquier tarjeta: un paso grabado,
                  una captura externa, una imagen pegada o un bloque de contenido, esté donde esté
                  de la lista. Lo que añadas mientras trabajas dentro de la carpeta (pegar una
                  imagen, capturar una ventana) entra directamente en ella.
                </li>
                <li>
                  <b>Sacarla</b> · el botón <b>⤴</b> de la tarjeta la deja suelta detrás de la
                  carpeta; arrastrarla fuera del bloque hace lo mismo.
                </li>
                <li>
                  <b>Dentro se sigue trabajando igual</b> · cada captura conserva su título (que se
                  publica como <b>pie</b> de la imagen), su descripción, su ✂ recorte, su nota y su
                  bloque de contenido. Se numeran <code>5·1</code>, <code>5·2</code>… porque el paso
                  del manual es la carpeta.
                </li>
                <li>
                  <b>▾ / ▸ Plegar</b> · la carpeta plegada enseña sus capturas en miniatura, en una
                  fila. Es solo la vista.
                </li>
                <li>
                  <b>Arrastrarla</b> · la carpeta se mueve <b>con sus capturas</b>.
                </li>
                <li>
                  <b>✕ Quitarla</b> · elimina <b>solo la carpeta</b>: sus capturas se conservan y
                  vuelven a ser pasos sueltos.
                </li>
              </ul>
              <p>
                <b>En el manual</b> · la carpeta es un paso numerado con su título y su descripción,
                y debajo van sus imágenes en orden, cada una con su pie. Las capturas no se numeran
                por separado: dirían que hay que hacer cuatro cosas donde solo se describe una.
              </p>
              <p>
                La carpeta no tiene captura propia ni entra en <code>flow.json</code>, pero{' '}
                <b>lo que hay dentro sí conserva lo suyo</b>: un paso grabado metido en una carpeta
                se sigue reproduciendo y <a onClick={() => go('regenerar')}>regenerando</a> como
                cualquier otro.
              </p>
            </section>

            <section id="secciones" data-help-section>
              <h3>Secciones</h3>
              <p>
                Agrupar une pasos en <b>uno</b>. Una <b>sección</b> hace lo contrario: los deja como
                están y les pone un <b>apartado</b> encima. Es lo que hace manejable una grabación
                de treinta pasos, que casi siempre tiene fases («preparación», «registro»,
                «cierre»).
              </p>
              <ul className="help-defs">
                <li>
                  <b>Crearla</b> · <b>+ Añadir → ▤ Sección</b>. Se coloca detrás de la tarjeta en la
                  que estés trabajando, así que marca antes el{' '}
                  <b>último paso del apartado anterior</b>: la sección encabeza lo que viene{' '}
                  <i>después</i> de ella. También puedes arrastrarla a su sitio.
                </li>
                <li>
                  <b>Qué contiene</b> · todos los pasos que van debajo hasta la sección siguiente.
                  El número junto al título dice cuántos son.
                </li>
                <li>
                  <b>▾ / ▸ Plegar</b> · oculta sus pasos en el panel para trabajar con la lista
                  completa a la vista. Es solo la vista: lo plegado se guarda y se publica igual, y
                  si grabas algo que cae dentro, la sección se abre sola.
                </li>
                <li>
                  <b>Arrastrarla</b> · la sección se mueve <b>con sus pasos</b>. Reordenar un
                  apartado entero es un solo arrastre.
                </li>
                <li>
                  <b>¶ Entradilla</b> · un párrafo opcional que presenta el apartado; se publica
                  justo debajo de su título.
                </li>
                <li>
                  <b>✕ Quitarla</b> · elimina <b>solo el título</b>: sus pasos se conservan y pasan
                  al apartado anterior.
                </li>
              </ul>
              <p>
                <b>En el manual</b> · cada sección sale como encabezado de nivel <code>##</code> y
                los pasos bajan a <code>###</code>, de modo que el índice lateral de Docusaurus
                muestra la página por apartados en vez de como una lista plana. La{' '}
                <b>numeración de los pasos sigue corrida</b> entre apartados (1, 2 · apartado · 3,
                4…), porque quien ejecuta el proceso cuenta pasos, no capítulos. Una página sin
                secciones se publica exactamente igual que antes.
              </p>
              <p>
                Las secciones no se numeran, no llevan captura, no entran en <code>flow.json</code>{' '}
                y <a onClick={() => go('regenerar')}>regenerar capturas</a> las salta: no hay nada
                que reproducir en ellas.
              </p>
            </section>

            <section id="captura" data-help-section>
              <h3>Capturas externas</h3>
              <p>
                Parte de lo que hay que documentar no está en el navegador: una plantilla de Excel,
                un PDF, un correo o una ventana de otra aplicación. Con{' '}
                <b>+ Añadir → 📷 Captura de pantalla</b> se incorpora esa imagen como un paso más
                del manual.
              </p>
              <ul className="help-defs">
                <li>
                  <b>Elegir la fuente</b> · se listan las <b>pantallas</b> y las <b>ventanas</b>{' '}
                  abiertas, con su miniatura. También puedes usar una <b>imagen del disco</b> que ya
                  tuvieras guardada.
                </li>
                <li>
                  <b>ocultar HiDocs</b> · al capturar una pantalla completa la app se aparta para no
                  salir en la imagen, y vuelve sola.
                </li>
                <li>
                  <b>✂ Recortar</b> · arrastra sobre la imagen la zona que quieres conservar y pulsa{' '}
                  <b>Aplicar</b>. Casi nunca se documenta la pantalla entera.
                </li>
                <li>
                  <b>▭ Señalar</b> · dibuja un recuadro naranja sobre lo que hay que mirar, el mismo
                  que la app pone sobre los elementos de la página.
                </li>
              </ul>
              <p>
                El paso resultante se comporta como cualquier otro: título, descripción, nota,
                bloque de contenido, orden y publicación. La única diferencia es que{' '}
                <a onClick={() => go('regenerar')}>regenerar capturas</a> no lo toca: esa imagen no
                la produce el navegador, así que se conserva tal cual.
              </p>
              <p>
                En <b>macOS</b>, la primera vez hay que autorizar la <b>grabación de pantalla</b> en
                Ajustes del sistema → Privacidad y seguridad, y reabrir HiDocs.
              </p>
              <p>
                Si la imagen ya la tienes copiada, no hace falta pasar por aquí: ver{' '}
                <a onClick={() => go('pegar')}>Pegar imágenes y tablas</a>.
              </p>
            </section>

            <section id="pegar" data-help-section>
              <h3>Pegar imágenes y tablas</h3>
              <p>
                Documentando, buena parte de lo que hay que dejar dicho <b>ya está copiado</b>: el
                recorte que acabas de hacer con las teclas del sistema, un diagrama de otra
                herramienta, la tabla de un correo. Con el panel de pasos enfocado, pulsa <b>⌘V</b>{' '}
                (Ctrl+V en Windows) y aparece una tarjeta nueva con eso dentro,{' '}
                <b>justo debajo de la tarjeta en la que estabas trabajando</b>: es el gesto pensado
                para el flujo real, grabar un paso y pegar acto seguido lo que lo acompaña.
              </p>
              <ul className="help-defs">
                <li>
                  <b>Una imagen</b> · se crea un paso <b>imagen</b> (borde verde). Se comporta como
                  cualquier otro paso: título, descripción, <a onClick={() => go('notas')}>nota</a>,{' '}
                  <a onClick={() => go('contenido')}>bloque de contenido</a>, orden y publicación.
                </li>
                <li>
                  <b>Texto o una tabla</b> · se crea un <b>bloque de contenido</b> con el texto ya
                  convertido a Markdown (las tablas conservan sus columnas).
                </li>
                <li>
                  <b>✂ en la tarjeta</b> · recorta la imagen o señala algo en ella con el recuadro
                  naranja, cuando haga falta. También puedes pegar y ajustar de una vez con{' '}
                  <b>+ Añadir → ✂ Pegar y ajustar</b>.
                </li>
                <li>
                  <b>+ Añadir → 📋 Imagen del portapapeles</b> · lo mismo que ⌘V, para cuando
                  prefieras el ratón.
                </li>
              </ul>
              <p>
                Dentro de un campo de texto —un título, una descripción, un bloque de contenido— ⌘V
                sigue pegando texto ahí, como siempre. La tarjeta solo se crea cuando el pegado no
                tiene otro destino. Y si acabas de usar el visor, haz clic en el panel antes de
                pegar: el sistema documentado y HiDocs son dos ventanas distintas para el teclado.
              </p>
              <p>
                Las imágenes pegadas <b>no se regeneran</b> (
                <a onClick={() => go('regenerar')}>Regenerar capturas</a>): no las produce el
                navegador, así que se conservan tal cual.
              </p>
            </section>

            <section id="contenido" data-help-section>
              <h3>Bloques de contenido</h3>
              <p>
                Un manual no son solo capturas: a veces hace falta una <b>tabla</b> con los valores
                admitidos de un campo, un <b>fragmento de código</b> o una explicación por{' '}
                <b>pestañas</b> según el rol. El bloque de contenido es donde se escribe eso con la
                misma sintaxis que entiende Docusaurus, y se ve el resultado al momento.
              </p>
              <ul className="help-defs">
                <li>
                  <b>Dónde</b> · el botón <b>▦</b> de cualquier paso le añade un bloque (se publica
                  entre la descripción y la captura), y <b>+ Añadir → ▦ Bloque de contenido</b> crea
                  un paso que es <i>solo</i> contenido, para material que no pertenece a ninguna
                  acción concreta. Ese paso no consume número de paso en el manual.
                </li>
                <li>
                  <b>Pegar una tabla</b> · copia una tabla del sistema que estás documentando y
                  pégala en el bloque: se convierte sola a tabla Markdown, con sus columnas.
                </li>
                <li>
                  <b>Barra</b> · inserta tablas, bloques de código con título, pestañas,
                  desplegables, encabezados, listas, citas, enlaces y formato en línea (incluidas
                  teclas con <code>&lt;kbd&gt;</code>).
                </li>
                <li>
                  <b>Vista previa</b> · muestra <b>exactamente</b> lo que se va a publicar. Con{' '}
                  <b>⤢</b> se abre a pantalla completa, con el código y el resultado lado a lado.
                </li>
                <li>
                  <b>Pestañas</b> · si usas <code>&lt;Tabs&gt;</code>, los <code>import</code> que
                  Docusaurus necesita se añaden solos a la página al guardar.
                </li>
                <li>
                  <b>🗑 Quitarlo</b> · el <b>▦</b> de la cabecera solo <i>abre y cierra</i> el
                  editor: lo escrito sigue ahí (y se publica) aunque lo cierres. Para deshacerte del
                  bloque usa el <b>🗑</b> del final de su barra, que pregunta antes si tiene texto.
                  En un paso que <i>es</i> el bloque, quitarlo sería eliminar el paso: para eso está
                  su <b>✕</b>.
                </li>
              </ul>
              <p>
                <b>Nada puede romper el sitio del mantenedor.</b> El texto se sanea antes de
                publicarse: el Markdown y las etiquetas conocidas y bien cerradas funcionan, y
                cualquier otra cosa —un <code>&lt;</code> suelto, una etiqueta desconocida o sin
                cerrar— se publica como texto visible en vez de tumbar la compilación. Cuando eso
                ocurre, el editor lo avisa debajo de la barra.
              </p>
            </section>

            <section id="notas" data-help-section>
              <h3>Notas destacadas</h3>
              <p>
                El botón <b>📝</b> de cada paso abre un recuadro para{' '}
                <b>recalcar algo importante</b> de ese paso o del grupo. Se publica como un{' '}
                <b>admonition de Docusaurus</b>, el mismo bloque coloreado con icono que ves en la
                documentación.
              </p>
              <ul className="help-defs">
                <li>
                  <b>Tipo</b> · elige entre <b>Nota</b>, <b>Consejo</b>, <b>Info</b>, <b>Aviso</b> y{' '}
                  <b>Peligro</b>; cada uno tiene su color e icono (<code>:::note</code>,{' '}
                  <code>:::tip</code>, <code>:::info</code>, <code>:::warning</code>,{' '}
                  <code>:::danger</code>).
                </li>
                <li>
                  <b>Título</b> · opcional; si lo dejas vacío, Docusaurus usa el del tipo.
                </li>
                <li>
                  <b>Barra de formato</b> · aplica <b>negrita</b>, <i>cursiva</i>,{' '}
                  <mark>resaltado</mark>, <code>código</code>, enlaces, listas y emojis sobre lo que
                  selecciones, igual que los <i>Markdown Features</i> de Docusaurus.
                </li>
                <li>
                  <b>Vista previa</b> · muestra en vivo cómo quedará el recuadro.
                </li>
                <li>
                  <b>🗑 Quitarla</b> · el <b>📝</b> de la cabecera solo <i>abre y cierra</i> el
                  editor: la nota sigue ahí (y se publica) aunque lo cierres. Para deshacerte de
                  ella usa el <b>🗑</b> de la fila de tipos, que pregunta antes si ya has escrito
                  algo.
                </li>
              </ul>
              <p>
                La nota aparece en el manual entre la descripción del paso y su captura. Si vacías
                su contenido, deja de publicarse.
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
                cosas del día a día: <b>seguir en una rama que ya empezaste</b> o{' '}
                <b>estrenar una</b>.
              </p>
              <ul className="help-defs">
                <li>
                  <b>Continuar en una rama</b> · elígela de la lista. La app lee la documentación
                  que esa rama ya tiene commiteada y <b>rellena por ti</b> el módulo, el rol y la
                  URL base con los que se venía trabajando: no hay que volver a escribir la cabecera
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
                  <b>Rama nueva</b> · escribe el nombre (se propone <code>docs/&lt;módulo&gt;</code>
                  ) y elige de qué rama <b>nace</b>. Si el nombre ya existe, se te avisa: el commit
                  se añadirá encima en vez de crear nada.
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
                La misma rama se puede elegir desde el campo <b>Rama</b> de la sección Git y desde
                el explorador de <a onClick={() => go('proyectos')}>Proyectos</a>: los tres sitios
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

            <section id="pendiente" data-help-section>
              <h3>Documentación sin registrar</h3>
              <p>
                Guardar escribe el paquete en el disco y, después, hace el commit. Son dos pasos a
                propósito: si el commit falla —cambios ajenos en el repositorio, una rama que no se
                puede cambiar— la grabación no se pierde. También puedes guardar con la casilla de
                Git desmarcada, o cerrar la aplicación antes de commitear.
              </p>
              <p>
                En todos esos casos el proceso queda entero en el disco pero fuera del historial, y
                el árbol de la rama no lo muestra (solo lee lo commiteado). La franja de estado lo
                avisa con <b>⚠ N sin registrar</b>: al pulsarlo se listan esos paquetes con su
                módulo, sus pasos y su carpeta, y de cada uno puedes:
              </p>
              <ul className="help-list">
                <li>
                  <b>Registrar en docs/&lt;módulo&gt;</b> · comitea la carpeta entera tal como está
                  (con su <code>img/</code> y los <code>_category_.json</code> que le falten) en la
                  rama de su módulo. Nunca sube nada a <code>origin</code>.
                </li>
                <li>
                  <b>Retomar sus datos</b> · recupera su módulo, subcategoría, rol y URL base para
                  seguir documentando ese proceso.
                </li>
                <li>
                  <b>Abrir carpeta</b> · para revisar el paquete en el explorador de archivos.
                </li>
                <li>
                  <b>Descartar</b> · lo contrario de registrar, para lo que no merece entrar en el
                  historial (una grabación de prueba, un proceso documentado dos veces, un intento a
                  medias). Lo que Git no conoce se manda a la <b>papelera del sistema</b> —se puede
                  recuperar desde el escritorio— y lo que ya estaba commiteado{' '}
                  <b>vuelve a su versión del último commit</b>. Se avisa antes de tocar nada y nunca
                  sale de la carpeta de ese paquete: el historial y el resto del repositorio no se
                  tocan.
                </li>
              </ul>
              <p>
                También aparece un paquete <b>ya commiteado y cambiado después</b> en el disco: es
                la señal de que hay una regeneración de capturas o una edición a mano sin registrar.
              </p>
            </section>

            <section id="docusaurus" data-help-section>
              <h3>Salida en disco e integración con Docusaurus</h3>
              <p>Cada grabación produce esta estructura dentro de la carpeta de salida:</p>
              <pre className="help-tree">
                {`<carpeta-de-salida>/   (idealmente la carpeta docs/ de Docusaurus)
└── <módulo>/
    ├── _category_.json        (etiqueta del módulo en la barra lateral)
    └── [<subcategoría>/]       (opcional; con su propio _category_.json)
        └── <funcionalidad>/
            ├── index.mdx      (la página del manual que Docusaurus muestra)
            ├── session.json   (la sesión completa)
            ├── flow.json      (acciones + selectores)
            └── img/paso-01.png …`}
              </pre>
              <p>
                La página <b>index.mdx</b> es el manual ya listo para Docusaurus: título, un
                apartado numerado por paso (que alimenta el índice lateral) y su captura. Los pasos
                sin «incluir en docs» se omiten; las <a onClick={() => go('notas')}>notas</a> se
                publican como admonitions. Si usas <b>subcategoría</b>, se añade un nivel de carpeta
                con su propio <code>_category_.json</code>, y Docusaurus anida el sidebar solo. Los{' '}
                <code>.json</code> conviven sin estorbar: Docusaurus solo renderiza <code>.md</code>{' '}
                / <code>.mdx</code>.
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
                  <b>✎ Editar esta documentación</b>, en esa misma vista previa: trae los pasos y
                  sus capturas al panel para corregirlos como una grabación normal (reordenar,
                  redactar con IA, añadir pasos o secciones). Al guardar se reescribe{' '}
                  <b>la misma carpeta</b> y el commit nuevo se apila <b>en la rama del commit</b>:
                  el original no se toca, el historial sigue contando lo que pasó. Si tienes una
                  grabación a medias, se avisa antes de sustituirla.
                </li>
                <li>
                  <b>Y se puede cancelar.</b> Mientras editas, el panel lleva arriba una franja que
                  dice <b>qué</b> estás editando, de qué commit salió y <b>dónde</b> se registrará,
                  con el botón <b>Descartar la edición</b>: vacía el panel y deja lo publicado como
                  está, sin registrar nada (cargarlo solo leyó de Git). Es la salida cuando abres
                  algo para mirarlo y decides no tocarlo: sin ella, la única a la vista sería ■, que
                  guarda y comitea.
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
                captura anterior) y el runner sigue con el resto. Las{' '}
                <a onClick={() => go('captura')}>capturas externas</a> y los{' '}
                <a onClick={() => go('contenido')}>bloques de contenido</a> se <b>saltan</b>: no
                salen del navegador y no hay nada que reproducir en ellos. Al final, un informe
                indica qué pasos se actualizaron y cuáles hay que revisar. Las capturas se
                sobrescriben en disco; tú revisas y comiteas con el flujo de Git normal.
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
                <b>Contexto (▢ Contexto)</b> · la IA ve la captura, pero no sabe cómo se llaman de
                verdad los campos, qué valida cada uno ni qué significa un código de la tabla. Pega
                ahí ese material —la tabla de campos, el texto de la especificación, un fragmento de
                código o SQL— y viajará como referencia con cada redacción. No se publica en el
                manual ni se guarda en el paquete: se conserva con el borrador, así que sobrevive a
                cerrar la aplicación.
              </p>
              <p>
                <b>Al terminar una guía se te pregunta qué hacer con él</b> · conservarlo es lo
                normal cuando documentas varios procesos del <b>mismo módulo</b>; vacíalo si el
                siguiente es de otra cosa, porque si no la IA redactaría la guía nueva con los
                nombres y las reglas de la anterior sin que se note. También puedes vaciarlo cuando
                quieras con <b>Quitar el contexto</b>, dentro de <b>▢ Contexto</b>.
              </p>
              <p>
                <b>Si la clave da un error raro</b> · el campo de la clave está enmascarado, así que
                un pegado equivocado no se ve. La aplicación rechaza lo que no puede ser una clave
                (espacios, acentos, emojis o un texto larguísimo) en el momento de guardarla.
              </p>
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
                  <b>Ctrl/Cmd + V</b> · con el panel de pasos enfocado, crea una tarjeta con lo que
                  tengas copiado (ver <a onClick={() => go('pegar')}>Pegar imágenes y tablas</a>).
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
