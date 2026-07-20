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
  { id: 'git', label: 'Integración con Git' },
  { id: 'docusaurus', label: 'Salida y Docusaurus' },
  { id: 'proyectos', label: 'Explorador de proyectos' },
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
                El resultado es un paquete portable (JSON + imágenes) pensado para alimentar un
                proyecto <b>Docusaurus</b>, y opcionalmente se registra en Git como una rama lista
                para abrir un Pull Request.
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
                  <b>■</b> Detener y guardar · finaliza y escribe el paquete.
                </li>
              </ul>
              <p>
                Durante la grabación, cada clic, escritura, selección o envío relevante genera un
                paso. La app espera a que la página se estabilice, resalta el elemento y toma la
                captura. Los campos de texto se consolidan en <b>un solo paso</b> (el valor final),
                y las <b>contraseñas se enmascaran</b> como <code>***</code>.
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
                El panel se puede <b>colapsar</b> (ver{' '}
                <a onClick={() => go('interfaz')}>Panel y tema</a>) para dar todo el ancho al visor.
              </p>
            </section>

            <section id="estado" data-help-section>
              <h3>Estado del proyecto</h3>
              <p>
                La franja bajo la barra superior resume, siempre visible, el repositorio de la
                sesión: nombre, rama activa, <b>de qué rama nacerá la próxima grabación</b>, si hay
                cambios pendientes (verde = limpio, ámbar = pendientes) y cuántos proyectos hay
                registrados. Si la carpeta no está en un repositorio, lo indica.
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
                  <b>Rama</b> · se sugiere <code>docs/&lt;módulo&gt;-&lt;funcionalidad&gt;</code>;
                  puedes elegir una rama existente de la lista o escribir una nueva.
                </li>
                <li>
                  <b>Mensaje del commit</b> · se sugiere{' '}
                  <code>docs(&lt;módulo&gt;): &lt;título&gt;</code>.
                </li>
                <li>
                  <b>Rama base</b> · las ramas nacen de la rama por defecto del repositorio (
                  <code>main</code>), no de la anterior. Puedes cambiar la base en el explorador de
                  Proyectos para continuar una línea ya empezada.
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
                  Elegir la <b>rama base</b> de la próxima grabación.
                </li>
                <li>
                  «Quitar de la lista» olvida la entrada del registro, sin tocar el repositorio en
                  disco.
                </li>
              </ul>
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
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
