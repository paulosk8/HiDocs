import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent
} from '@dnd-kit/core'
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import type { RecordedStep } from '../../../shared/ipc-contract'
import type { SaveResult } from '../../../shared/types'
import { ipc } from '../ipc'
import { groupSize, sectionSize, selectionProblem, useSession } from '../store'
import { invalidateBranches } from '../useBranches'
import { GROUP_DROP_PREFIX, GroupCard } from './GroupCard'
import { SectionCard } from './SectionCard'
import { StepCard } from './StepCard'
import { ShotModal } from './ShotModal'
import { CaptureModal } from './CaptureModal'
import { ContentModal } from './ContentModal'
import { ConfirmDialog } from './ConfirmDialog'
import { ChecksModal } from './ChecksModal'
import { GitSection } from './GitSection'
import { DocsChecksSection } from './DocsChecksSection'
import { suggestBranchName, suggestCommitMessage } from '../../../shared/naming'
import { useAiDraft } from '../useAiDraft'
import { useGroupCapture } from '../useGroupCapture'
import { usePasteStep } from '../usePasteStep'
import { isEditable } from '../paste-step'

/** Pasos que tiene sentido mandar a redactar: los que se publican y se ejecutan. */
function draftable(step: RecordedStep): boolean {
  return step.includeInDocs && step.kind !== 'section'
}

export function StepsPanel(): React.JSX.Element {
  const steps = useSession((s) => s.steps)
  const status = useSession((s) => s.status)
  const attached = useSession((s) => s.attached)
  const reorderSteps = useSession((s) => s.reorderSteps)
  const applyEngineState = useSession((s) => s.applyEngineState)
  const startFreshSession = useSession((s) => s.startFreshSession)
  const collapsed = useSession((s) => s.panelCollapsed)
  const togglePanel = useSession((s) => s.togglePanel)
  const projectsOpen = useSession((s) => s.projectsOpen)
  const branchPickerOpen = useSession((s) => s.branchPickerOpen)
  const helpOpen = useSession((s) => s.helpOpen)
  const docusaurusIntroOpen = useSession((s) => s.docusaurusIntroOpen)
  const groupConsecutive = useSession((s) => s.groupConsecutive)
  const setGroupConsecutive = useSession((s) => s.setGroupConsecutive)
  const aiOpen = useSession((s) => s.aiOpen)
  const aiContextOpen = useSession((s) => s.aiContextOpen)
  const setAiContextOpen = useSession((s) => s.setAiContextOpen)
  const pendingDocsOpen = useSession((s) => s.pendingDocsOpen)
  const aiContext = useSession((s) => s.meta.aiContext ?? '')
  const aiBusyIds = useSession((s) => s.aiBusyIds)
  const aiProgress = useSession((s) => s.aiProgress)
  const aiError = useSession((s) => s.aiError)
  const setAiError = useSession((s) => s.setAiError)
  const selectedIds = useSession((s) => s.selectedIds)
  const clearSelection = useSession((s) => s.clearSelection)
  const groupSelected = useSession((s) => s.groupSelected)
  const removeSelected = useSession((s) => s.removeSelected)
  const addManualStep = useSession((s) => s.addManualStep)
  const addToGroup = useSession((s) => s.addToGroup)
  const setMeta = useSession((s) => s.setMeta)
  const wideContentId = useSession((s) => s.wideContentId)
  const setWideContentId = useSession((s) => s.setWideContentId)
  const updateStep = useSession((s) => s.updateStep)
  const activeStepId = useSession((s) => s.activeStepId)
  const collapsedSections = useSession((s) => s.collapsedSections)
  const editing = useSession((s) => s.editing)
  const discardEditing = useSession((s) => s.discardEditing)
  const checksRun = useSession((s) => s.checksRun)
  const checksReport = useSession((s) => s.checksReport)
  const { draft } = useAiDraft()
  const recaptureGroup = useGroupCapture()
  const {
    pasteFromEvent,
    pasteFromClipboard,
    problem: pasteProblem,
    clearProblem: clearPasteProblem
  } = usePasteStep()

  const [addOpen, setAddOpen] = useState(false)
  /**
   * El diálogo de la imagen, en sus tres formas: elegir una fuente que capturar,
   * ajustar lo que se acaba de pegar antes de crear la tarjeta, o retocar la
   * imagen de una tarjeta que ya existe (`stepId`).
   */
  const [capture, setCapture] = useState<
    | { mode: 'source' }
    | { mode: 'paste'; file: string }
    | { mode: 'edit'; stepId: string; file: string; name: string }
    | null
  >(null)
  const addRef = useRef<HTMLDivElement>(null)
  /**
   * Momento del último pegado atendido POR LA TECLA. Si el mismo gesto acaba
   * emitiendo además un evento `paste`, se ignora: si no, una sola pulsación
   * crearía dos tarjetas.
   */
  const keyPasteAt = useRef(0)
  const [shot, setShot] = useState<RecordedStep | null>(null)
  const [pendingSave, setPendingSave] = useState<{ untitled: number } | null>(null)
  const [pendingCommit, setPendingCommit] = useState<{
    branch: string
    message: string
    untitled: number
  } | null>(null)
  /** confirmación de «descartar la edición» (no registra nada) */
  const [discardEdit, setDiscardEdit] = useState(false)
  /**
   * Se acaba de estrenar sesión con material de referencia puesto: hay que
   * preguntar si sigue valiendo. Ver el diálogo, más abajo.
   */
  const [askContext, setAskContext] = useState(false)
  const [result, setResult] = useState<SaveResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Por qué no se puede agrupar lo marcado (o null si sí se puede): se muestra
  // como pista en la barra de selección en vez de dejar el botón mudo.
  const groupProblem = selectedIds.length ? selectionProblem(steps, selectedIds) : null
  const wideStep = steps.find((s) => s.id === wideContentId) ?? null

  // Dónde va a caer lo que se añada. Insertar junto a la tarjeta en la que se
  // trabaja es lo natural documentando, pero solo se adivina si se dice.
  const activeIndex = steps.findIndex((s) => s.id === activeStepId)
  const insertHint =
    activeIndex >= 0 && activeIndex < steps.length - 1
      ? `Se insertará detrás de la tarjeta ${activeIndex + 1} de la lista.`
      : 'Se añadirá al final.'

  // El recuento del encabezado cuenta PASOS: una sección es un título, y sumarla
  // haría que el panel dijera 12 donde el manual numera 10. Las capturas de una
  // carpeta tampoco cuentan: son las ilustraciones de un paso, no pasos.
  const stepCount = steps.filter((s) => s.kind !== 'section' && !s.groupId).length

  // Lo que se pinta: las secciones y las carpetas siempre, y lo que cuelga de las
  // que estén desplegadas. Plegar es lo que hace manejable una grabación de
  // cuarenta pasos, y solo afecta a la vista: lo plegado se guarda y se publica
  // igual.
  //
  // Aquí se calcula también la chapa de cada tarjeta: el número del paso, o
  // «5·2» dentro de una carpeta, donde el paso del manual es la carpeta y la
  // tarjeta es su segunda captura.
  const visible = useMemo(() => {
    const rows: {
      step: RecordedStep
      count: number
      nested: boolean
      badge: string
      inGroup: boolean
    }[] = []
    let hidden = false
    // `nested` sangra los pasos que cuelgan de una sección: sin ese escalón, una
    // sección parece un separador suelto y no se ve dónde acaba su apartado.
    let nested = false
    let folder: { badge: string; collapsed: boolean } | null = null
    let inside = 0
    steps.forEach((step, index) => {
      if (step.kind === 'section') {
        hidden = collapsedSections.includes(step.id)
        nested = true
        folder = null
        rows.push({
          step,
          count: sectionSize(steps, index),
          nested: false,
          badge: '',
          inGroup: false
        })
        return
      }
      if (step.groupId) {
        inside++
        if (hidden || !folder || folder.collapsed) return
        rows.push({ step, count: 0, nested, badge: `${folder.badge}·${inside}`, inGroup: true })
        return
      }
      folder = null
      if (hidden) return
      const badge = String(step.order)
      if (step.kind === 'group') {
        folder = { badge, collapsed: collapsedSections.includes(step.id) }
        inside = 0
        rows.push({ step, count: groupSize(steps, index), nested, badge, inGroup: false })
        return
      }
      rows.push({ step, count: 0, nested, badge, inGroup: false })
    })
    return rows
  }, [steps, collapsedSections])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  /**
   * La zona de una carpeta gana cuando el puntero está DENTRO de ella; en
   * cualquier otro sitio se reordena como siempre.
   *
   * Con `closestCenter` a secas no habría forma de distinguir las dos cosas: la
   * zona vive dentro de la tarjeta de la carpeta, y soltar cerca de ella
   * significaría a veces «mete esto dentro» y a veces «ponlo antes». Exigir el
   * puntero encima hace el gesto explícito. Arrastrando con el teclado no hay
   * puntero: entonces solo se reordena, que es lo que el teclado puede expresar.
   */
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const dropZones = pointerWithin(args).filter((c) => String(c.id).startsWith(GROUP_DROP_PREFIX))
    return dropZones.length ? dropZones : closestCenter(args)
  }, [])

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const overId = String(over.id)
    if (overId.startsWith(GROUP_DROP_PREFIX)) {
      addToGroup(String(active.id), overId.slice(GROUP_DROP_PREFIX.length))
      return
    }
    const from = steps.findIndex((s) => s.id === active.id)
    const to = steps.findIndex((s) => s.id === over.id)
    if (from >= 0 && to >= 0) reorderSteps(from, to)
  }

  // Los manejadores asíncronos leen el estado con `getState()`: detener la
  // grabación puede emitir todavía un último paso, y una copia capturada en el
  // render lo perdería.
  const write = useCallback(
    async (options?: { skipVerify?: boolean }): Promise<void> => {
      const s = useSession.getState()
      setBusy(true)
      // El diálogo de la comprobación se abre ANTES de invocar el guardado: los
      // comandos tardan y el progreso llega por eventos, así que sin abrirlo aquí
      // la app pasaría un minuto larga sin decir qué está haciendo. Solo si de
      // verdad hay algo que ejecutar en el proyecto de destino.
      const verifying =
        s.gitEnabled &&
        s.gitVerify &&
        !options?.skipVerify &&
        (s.docsChecks?.checks.length ?? 0) > 0
      if (verifying) s.checksStart('commit')
      try {
        const saved = await ipc.invoke('session:save', {
          meta: s.meta,
          viewport: s.viewport,
          sessionId: s.sessionId,
          createdAt: s.createdAt,
          outputDir: s.outputDir,
          steps: s.steps,
          git: s.gitEnabled
            ? {
                enabled: true,
                branch: s.gitBranchOverride ?? suggestBranchName(s.meta.module),
                message:
                  s.gitMessageOverride ??
                  suggestCommitMessage(s.meta.module, s.meta.feature, s.meta.title),
                push: s.gitPush,
                // Sin elección explícita se omite, y el main resuelve la rama por
                // defecto del repositorio.
                baseBranch: s.gitBaseBranch ?? undefined,
                verify: verifying
              }
            : undefined
        })
        // La comprobación falló: NO hay commit. El paquete sí está escrito, así
        // que la sesión se conserva tal cual —con sus pasos y su borrador— para
        // poder corregir y volver a pulsar ■. Estrenar sesión aquí sería tirar el
        // trabajo justo cuando hace falta.
        if (saved.checks && !saved.checks.ok) {
          useSession.getState().checksFinish({ result: saved.checks })
          return
        }
        useSession.getState().checksFinish()
        setResult(saved)
        // Guardar es lo único que mueve el repositorio desde dentro de la app: el
        // commit cambia de rama, puede crear una y deja el árbol limpio. Sin releer
        // aquí, la franja de estado y el selector seguirían describiendo el
        // repositorio de antes del commit hasta el próximo cambio de carpeta.
        void ipc.invoke('git:inspect', s.outputDir).then(useSession.getState().setGitRepo)
        invalidateBranches()
        // Guardado con éxito: se descarta el borrador y se estrena sesión para la
        // siguiente funcionalidad. Se estrena ANTES de borrar el archivo para que
        // un autoguardado pendiente no vuelva a crear el borrador.
        startFreshSession()
        // El material de referencia describe el proceso que se acaba de terminar.
        // Conservarlo es lo correcto documentando varios procesos del mismo módulo,
        // y un estorbo cuando la siguiente guía es de otra cosa: la IA redactaría
        // con los nombres de la anterior sin que nadie lo note. Se pregunta al
        // estrenar sesión, que es cuando la respuesta se conoce.
        if (useSession.getState().meta.aiContext?.trim()) setAskContext(true)
        void ipc.invoke('draft:clear')
      } catch (err) {
        useSession.getState().checksFinish()
        setProblem(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
        setPendingSave(null)
      }
    },
    [startFreshSession]
  )

  /**
   * Detiene la grabación de verdad y termina de guardar. Se llama al confirmar
   * el aviso de Git, o directamente cuando no hay Git. Detener vacía la cola del
   * motor y puede emitir un último paso, por eso el estado se relee después.
   */
  const finishSave = useCallback(async (): Promise<void> => {
    applyEngineState(await ipc.invoke('recorder:stop'))
    const s = useSession.getState()
    const untitled = s.steps.filter((step) => !step.title.trim()).length
    // Sin Git, el aviso de pasos sin título es el último filtro; con Git ya se
    // avisó de ello en la confirmación del commit.
    if (untitled > 0 && !s.gitEnabled) {
      setPendingSave({ untitled })
      return
    }
    await write()
  }, [write, applyEngineState])

  /**
   * Detener y guardar (§8).
   *
   * Si falta algún dato, la grabación se detiene IGUALMENTE y el aviso dice qué
   * falta: pulsar ■ significa «he terminado». Antes se validaba primero y, al
   * faltar un dato, el botón solo mostraba el aviso y la captura seguía viva,
   * con lo que parecía no responder. Los pasos se conservan (y el borrador se
   * autoguarda), así que basta completar arriba y volver a pulsar ■.
   *
   * En cambio, si se va a registrar en Git se avisa ANTES de detener: eso no es
   * un error sino una decisión, el commit cuesta deshacerlo y a veces la
   * documentación aún no está completa. Así, cancelar deja la grabación intacta
   * y se puede seguir sin tener que reanudar.
   */
  const stopAndSave = async (): Promise<void> => {
    const s = useSession.getState()

    const missing: string[] = []
    if (!s.meta.module.trim()) missing.push('módulo')
    if (!s.meta.feature.trim()) missing.push('funcionalidad')
    if (!s.outputDir) missing.push('carpeta de salida')

    if (missing.length || !s.steps.length) {
      applyEngineState(await ipc.invoke('recorder:stop'))
      if (missing.length) {
        setProblem(
          `La grabación se ha detenido, pero todavía no se puede guardar: falta indicar ${missing.join(', ')}.\n\n` +
            'Complétalo en la barra superior y vuelve a pulsar ■. Tus pasos siguen aquí.'
        )
        return
      }
      // Detener vacía la cola del motor y puede emitir un último paso, así que
      // se relee antes de dar la grabación por vacía.
      if (!useSession.getState().steps.length) {
        setProblem('No hay pasos que guardar. La grabación se ha detenido.')
        return
      }
    }

    if (s.gitEnabled) {
      setPendingCommit({
        branch: s.gitBranchOverride ?? suggestBranchName(s.meta.module),
        message:
          s.gitMessageOverride ?? suggestCommitMessage(s.meta.module, s.meta.feature, s.meta.title),
        untitled: s.steps.filter((step) => !step.title.trim()).length
      })
      return
    }

    await finishSave()
  }

  const toggleRecording = useCallback(async () => {
    const current = useSession.getState().status
    if (current === 'recording') applyEngineState(await ipc.invoke('recorder:pause'))
    else if (current === 'paused') applyEngineState(await ipc.invoke('recorder:resume'))
  }, [applyEngineState])

  // Atajo global Ctrl+Shift+R: pausar/reanudar sin volver al panel.
  useEffect(
    () => ipc.on('recorder:toggle-shortcut', () => void toggleRecording()),
    [toggleRecording]
  )

  // El menú «Añadir» se cierra al pulsar fuera o con Escape, como el resto de
  // desplegables de la app.
  useEffect(() => {
    if (!addOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!addRef.current?.contains(e.target as Node)) setAddOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAddOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [addOpen])

  // El WebContentsView se pinta por encima del HTML del renderer, así que
  // cualquier superposición propia exige ocultarlo mientras esté abierta. Incluye
  // el explorador de proyectos: si no, la página nativa lo tapa y solo asoma su
  // borde derecho, que parece un recuadro vacío sin sentido.
  const modalOpen =
    shot !== null ||
    pendingSave !== null ||
    pendingCommit !== null ||
    result !== null ||
    problem !== null ||
    projectsOpen ||
    // El selector de rama es pequeño y cuelga de la franja, pero cae justo sobre
    // el rectángulo de la vista nativa: sin esto quedaría tapado por la página.
    branchPickerOpen ||
    helpOpen ||
    docusaurusIntroOpen ||
    aiOpen ||
    aiContextOpen ||
    pendingDocsOpen ||
    capture !== null ||
    wideContentId !== null ||
    pasteProblem !== null ||
    discardEdit ||
    askContext ||
    checksRun !== null ||
    checksReport !== null ||
    aiError !== null
  useEffect(() => {
    void ipc.invoke('viewport:set-visible', !modalOpen)
  }, [modalOpen])

  /**
   * Pegar (⌘/Ctrl+V) crea la tarjeta de lo que haya en el portapapeles: una
   * imagen, o un bloque de contenido si es texto. Es el atajo del flujo real —se
   * graba un paso, se recorta algo por fuera y se pega aquí mismo— y por eso se
   * escucha en todo el panel y no en un campo concreto.
   *
   * Se escucha por partida doble a propósito. Fuera de un campo editable, pulsar
   * la tecla NO produce un evento `paste`: el navegador solo lo emite cuando el
   * pegado tiene dónde caer, así que sin el `keydown` el atajo no existiría. Y el
   * evento hace falta igualmente porque hay pegados que sí lo emiten (y traen los
   * datos consigo, sin preguntar al portapapeles del sistema). Cuando un mismo
   * gesto dispara los dos, manda la tecla —llega primero— y el evento que venga
   * detrás se descarta por eco. La ventana es corta a propósito: solo cubre el eco
   * de una pulsación, no dos pegados seguidos, que son dos tarjetas legítimas.
   *
   * No se toca el pegado que ya tenía sentido: dentro de un campo de texto se
   * pega texto, y con una superposición abierta manda ella (el diálogo de la
   * imagen tiene su propio pegado).
   */
  useEffect(() => {
    if (modalOpen) return
    const onPaste = (event: ClipboardEvent): void => {
      if (isEditable(event.target)) return
      event.preventDefault()
      // El mismo gesto ya se atendió por la tecla: este evento es su eco.
      if (Date.now() - keyPasteAt.current < 250) return
      void pasteFromEvent(event.clipboardData)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'v') return
      if (event.altKey || event.shiftKey || isEditable(event.target)) return
      event.preventDefault()
      keyPasteAt.current = Date.now()
      void pasteFromClipboard()
    }
    document.addEventListener('paste', onPaste)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [modalOpen, pasteFromEvent, pasteFromClipboard])

  const record = async (): Promise<void> => {
    setProblem(null)
    setResult(null)
    applyEngineState(await ipc.invoke('recorder:start'))
  }

  // Los tres controles de grabación se muestran tanto en el encabezado del panel
  // abierto (en fila) como en la tira colapsada (en columna), así que se definen
  // una sola vez.
  const controls = (
    <>
      <button
        className="ctrl ctrl-record"
        disabled={status === 'recording'}
        title="Grabar"
        onClick={() => void record()}
      >
        ●
      </button>
      <button
        className="ctrl"
        disabled={status === 'idle'}
        title={status === 'paused' ? 'Reanudar (Ctrl+Shift+R)' : 'Pausar (Ctrl+Shift+R)'}
        onClick={() => void toggleRecording()}
      >
        {status === 'paused' ? '▶' : '⏸'}
      </button>
      <button
        className="ctrl"
        disabled={busy || (status === 'idle' && steps.length === 0)}
        title={editing ? 'Guardar los cambios y registrarlos en Git' : 'Detener y guardar'}
        onClick={() => void stopAndSave()}
      >
        ■
      </button>
    </>
  )

  // Los diálogos se montan igual en ambos estados del panel: guardar (y sus
  // avisos) debe funcionar también con el panel colapsado.
  const dialogs = (
    <>
      {/* La comprobación del sitio: mientras corre y cuando termina mal. Va
          primero porque puede aparecer sobre cualquier otra cosa del panel. */}
      <ChecksModal onCommitAnyway={() => void write({ skipVerify: true })} />

      {shot && <ShotModal step={shot} onClose={() => setShot(null)} />}

      {capture && (
        <CaptureModal
          initial={
            capture.mode === 'paste'
              ? { file: capture.file, name: 'Imagen pegada' }
              : capture.mode === 'edit'
                ? { file: capture.file, name: capture.name }
                : null
          }
          confirmLabel={capture.mode === 'edit' ? 'Guardar la imagen' : 'Añadir como paso'}
          onClose={() => setCapture(null)}
          onCaptured={(file, sourceName) => {
            // Ajustando la imagen de una tarjeta solo cambia su imagen: el título,
            // la descripción y la nota que ya se hubieran escrito se conservan.
            if (capture.mode === 'edit') updateStep(capture.stepId, { tempFile: file })
            // El título de partida nombra el origen («Captura de Excel»); es
            // editable y la IA puede redactarlo mejor, pero nunca queda vacío.
            else if (capture.mode === 'paste')
              addManualStep({ kind: 'image', title: 'Imagen pegada', tempFile: file })
            else
              addManualStep({ kind: 'capture', title: `Captura de ${sourceName}`, tempFile: file })
            setCapture(null)
          }}
        />
      )}

      {pasteProblem && (
        <ConfirmDialog
          title="No se pudo pegar"
          body={pasteProblem}
          confirmLabel="Entendido"
          onConfirm={clearPasteProblem}
        />
      )}

      {wideStep && (
        <ContentModal
          title={wideStep.title}
          value={wideStep.content ?? ''}
          onChange={(content) => updateStep(wideStep.id, { content })}
          onClose={() => setWideContentId(null)}
          // En un paso que ES el bloque, quitarlo sería eliminar el paso.
          onRemove={
            wideStep.kind === 'content'
              ? undefined
              : () => {
                  updateStep(wideStep.id, { content: '' })
                  setWideContentId(null)
                }
          }
        />
      )}

      {pendingCommit && (
        <ConfirmDialog
          title="Detener y registrar en Git"
          body={[
            'Se guardará la documentación y se registrará en Git:',
            `\n· Rama: ${pendingCommit.branch}`,
            `· Commit: ${pendingCommit.message}`,
            pendingCommit.untitled > 0
              ? `\n${pendingCommit.untitled} paso(s) todavía sin título.`
              : '',
            '\nSi aún no está completa, cancela y sigue grabando: la grabación no se detiene.'
          ]
            .filter(Boolean)
            .join('\n')}
          confirmLabel="Registrar en Git"
          cancelLabel="Seguir grabando"
          onConfirm={() => {
            setPendingCommit(null)
            void finishSave()
          }}
          onCancel={() => setPendingCommit(null)}
        />
      )}

      {pendingSave && (
        <ConfirmDialog
          title="Hay pasos sin título"
          body={`${pendingSave.untitled} de ${stepCount} pasos no tienen título. Puedes guardar igualmente y completarlos después.`}
          confirmLabel="Guardar de todos modos"
          onConfirm={() => void write()}
          onCancel={() => setPendingSave(null)}
        />
      )}

      {discardEdit && (
        <ConfirmDialog
          title="Descartar la edición"
          body={[
            `Se vaciará el panel y «${editing?.title ?? ''}» se quedará como está publicada.`,
            '',
            'No se registra nada: el commit del que salió no se toca, y el paquete del',
            'repositorio tampoco (cargarlo solo leyó de Git).',
            '',
            'Lo que hayas escrito aquí se pierde.'
          ].join('\n')}
          confirmLabel="Descartar"
          cancelLabel="Seguir editando"
          tone="danger"
          onConfirm={() => {
            setDiscardEdit(false)
            discardEditing()
            if (useSession.getState().meta.aiContext?.trim()) setAskContext(true)
            // El borrador guardaba esta edición: sin borrarlo, al abrir la app
            // mañana se ofrecería continuar lo que se acaba de descartar.
            void ipc.invoke('draft:clear')
          }}
          onCancel={() => setDiscardEdit(false)}
        />
      )}

      {/* Sesión nueva con el contexto de la anterior todavía puesto. Va después
          del aviso de guardado (`!result`) para no encadenar dos diálogos: se
          lee uno, se cierra, y entonces aparece este. */}
      {askContext && !result && (
        <ConfirmDialog
          title="¿Sigue valiendo el contexto para la IA?"
          body={[
            `Tienes ${aiContext.length.toLocaleString('es')} caracteres de material de referencia,`,
            'pegados para la guía que acabas de terminar. Se envían con cada redacción.',
            '',
            'Si la siguiente guía es de otro proceso, vacíalo: la IA redactaría con los',
            'nombres y las reglas del anterior. Si sigues en el mismo módulo, consérvalo.'
          ].join('\n')}
          confirmLabel="Vaciar el contexto"
          cancelLabel="Conservarlo"
          onConfirm={() => {
            setMeta({ aiContext: '' })
            setAskContext(false)
          }}
          onCancel={() => setAskContext(false)}
        />
      )}

      {aiError && (
        <ConfirmDialog
          title="No se pudo redactar con IA"
          body={aiError}
          confirmLabel="Entendido"
          onConfirm={() => setAiError(null)}
        />
      )}

      {problem && (
        <ConfirmDialog
          title="No se puede guardar"
          body={problem}
          confirmLabel="Entendido"
          onConfirm={() => setProblem(null)}
        />
      )}

      {result && (
        <ConfirmDialog
          title="Documentación guardada"
          body={[
            `${result.stepsWritten} pasos y ${result.imagesWritten} capturas en:`,
            result.path,
            result.git ? `\n${result.git.message}` : '',
            result.gitError
              ? `\nEl paquete se guardó, pero no se registró en Git:\n${result.gitError}`
              : ''
          ]
            .filter(Boolean)
            .join('\n')}
          confirmLabel="Abrir carpeta"
          cancelLabel="Cerrar"
          onConfirm={() => {
            void ipc.invoke('shell:open-path', result.path)
            setResult(null)
          }}
          onCancel={() => setResult(null)}
        />
      )}
    </>
  )

  // Colapsado: una tira estrecha con lo imprescindible para grabar sin volver a
  // abrir el panel. El viewport recupera el ancho y la página muestra su menú
  // lateral. Los diálogos siguen montados fuera de este condicional para que
  // guardar desde la tira también funcione.
  if (collapsed) {
    return (
      <aside className="panel collapsed">
        <div className="panel-strip">
          <button
            className="strip-toggle"
            onClick={togglePanel}
            title="Expandir el panel de pasos"
            aria-label="Expandir el panel de pasos"
          >
            «
          </button>
          <span className="count" title={`${stepCount} paso(s)`}>
            {stepCount}
          </span>
          <div className="controls controls-vertical">{controls}</div>
        </div>
        {dialogs}
      </aside>
    )
  }

  return (
    <aside className="panel">
      {/* Editando algo ya publicado: qué es, dónde irá y cómo salir sin registrar
          nada. Sin esta franja, el panel aparece lleno de pasos que nadie ha
          grabado aquí y la única salida a la vista es ■, que guarda y comitea. */}
      {editing && (
        <div className="editing-strip">
          <span className="editing-what">
            ✎ Editando <b>{editing.title}</b>
          </span>
          <button
            className="btn"
            title="Vaciar el panel y dejar la documentación publicada como está. No se registra nada."
            onClick={() => setDiscardEdit(true)}
          >
            Descartar la edición
          </button>
          <span className="muted editing-where">
            commit {editing.commit} · se registrará en <code>{editing.branch}</code> sobre{' '}
            <code>{editing.dir}</code>
          </span>
        </div>
      )}

      <div className="panel-header">
        <button
          className="strip-toggle"
          onClick={togglePanel}
          title="Colapsar el panel (da ancho a la página)"
          aria-label="Colapsar el panel de pasos"
        >
          »
        </button>
        <h2>Pasos</h2>
        <span className="count">{stepCount}</span>
        <div className="controls">{controls}</div>
      </div>

      {/* Segunda fila: lo que se HACE con los pasos, separado de los controles de
          grabación. Cuando hay pasos marcados, esta fila pasa a ser la barra de
          selección: las acciones que ofrece son otras y mezclarlas confundía. */}
      {selectedIds.length > 0 ? (
        <div className="panel-toolbar selection">
          <span className="selection-count">{selectedIds.length} marcado(s)</span>
          <button
            className="btn primary"
            disabled={groupProblem !== null}
            title={groupProblem ?? 'Funde los pasos marcados en uno solo'}
            onClick={() => recaptureGroup(groupSelected())}
          >
            ⊞ Agrupar
          </button>
          <button className="btn danger" onClick={removeSelected}>
            Eliminar
          </button>
          <button className="btn" onClick={clearSelection}>
            Cancelar
          </button>
          {groupProblem && <span className="muted selection-hint">{groupProblem}</span>}
        </div>
      ) : (
        <div className="panel-toolbar">
          <div className="add-menu" ref={addRef}>
            <button
              className="btn"
              aria-expanded={addOpen}
              title={`Añadir algo que no se graba: una imagen pegada, una captura externa, un bloque de contenido o una sección. ${insertHint}`}
              onClick={() => setAddOpen((v) => !v)}
            >
              + Añadir ▾
            </button>
            {addOpen && (
              <div className="add-menu-list" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setAddOpen(false)
                    void pasteFromClipboard()
                  }}
                >
                  📋 Imagen del portapapeles
                  <small>Lo que tengas copiado, tal cual (⌘/Ctrl+V)</small>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setAddOpen(false)
                    void ipc.invoke('clipboard:read').then((clip) => {
                      if (clip.file) setCapture({ mode: 'paste', file: clip.file })
                      // Sin imagen que ajustar se cae al selector de fuentes, que
                      // es de donde se puede sacar una.
                      else setCapture({ mode: 'source' })
                    })
                  }}
                >
                  ✂ Pegar y ajustar…
                  <small>Recortar o señalar antes de crear la tarjeta</small>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setAddOpen(false)
                    setCapture({ mode: 'source' })
                  }}
                >
                  📷 Captura de pantalla…
                  <small>Otra ventana, el escritorio o una imagen del disco</small>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setAddOpen(false)
                    addManualStep({ kind: 'content', title: '' })
                  }}
                >
                  ▦ Bloque de contenido
                  <small>Una tabla, código o pestañas de Docusaurus</small>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setAddOpen(false)
                    addManualStep({ kind: 'group', title: '' })
                  }}
                >
                  📁 Carpeta de capturas
                  <small>Un paso con varias capturas; arrastra dentro las tarjetas</small>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setAddOpen(false)
                    addManualStep({ kind: 'section', title: '' })
                  }}
                >
                  ▤ Sección
                  <small>Encabeza los pasos siguientes; se pliega y se mueve entera</small>
                </button>
              </div>
            )}
          </div>

          {/* Solo se redactan los pasos que van al manual: pagar tokens por un paso
              excluido de la documentación no tendría sentido. Las secciones
              tampoco: su título lo pone quien decide la estructura. */}
          <button
            className="btn btn-ai"
            disabled={aiBusyIds.length > 0 || !steps.some(draftable)}
            title="Propone título y descripción para todos los pasos incluidos en la documentación"
            onClick={() => void draft(steps.filter(draftable).map((s) => s.id))}
          >
            {aiBusyIds.length > 0
              ? `Redactando ${aiProgress ? `${aiProgress.done}/${aiProgress.total}` : ''}…`
              : '✨ Redactar todos'}
          </button>

          {/* El contexto es lo que hace que «Redactar todos» acierte con los
              nombres del sistema, así que vive junto a él y no en los ajustes. */}
          <button
            className={aiContext ? 'btn btn-context set' : 'btn btn-context'}
            title={
              aiContext
                ? `Material de referencia para la IA (${aiContext.length} caracteres). Se envía con cada redacción.`
                : 'Pega un texto o código de referencia para que la IA redacte con los nombres reales del sistema'
            }
            onClick={() => setAiContextOpen(true)}
          >
            {aiContext ? '▣ Contexto' : '▢ Contexto'}
            {aiContext && <em className="context-size">{Math.ceil(aiContext.length / 1000)} k</em>}
          </button>

          <label
            className="group-toggle"
            title="Une en un solo paso los controles seguidos del MISMO tipo: los campos de un formulario, las casillas de una misma columna de la tabla, varias pestañas o varios botones. Al cambiar de tipo empieza un paso nuevo. Para unir cosas distintas, marca los pasos con su casilla."
          >
            <input
              type="checkbox"
              checked={groupConsecutive}
              onChange={(e) => setGroupConsecutive(e.target.checked)}
            />
            agrupar seguidos
          </label>
        </div>
      )}

      <div className="panel-body">
        {!attached && status === 'idle' && steps.length === 0 && (
          <p className="empty">
            Los pasos que captures aparecerán aquí, cada uno con su captura y su selector.
          </p>
        )}
        {attached && steps.length === 0 && (
          <p className="empty">
            {status === 'recording'
              ? 'Grabando… interactúa con el sistema.'
              : 'Pulsa ● para empezar a grabar.'}
          </p>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={visible.map((row) => row.step.id)}
            strategy={verticalListSortingStrategy}
          >
            {visible.map(({ step, count, nested, badge, inGroup }) =>
              step.kind === 'section' ? (
                <SectionCard key={step.id} step={step} count={count} />
              ) : step.kind === 'group' ? (
                <GroupCard key={step.id} step={step} count={count} nested={nested} badge={badge} />
              ) : (
                <StepCard
                  key={step.id}
                  step={step}
                  nested={nested}
                  badge={badge}
                  inGroup={inGroup}
                  onOpenShot={setShot}
                  onAdjustImage={(target) =>
                    setCapture({
                      mode: 'edit',
                      stepId: target.id,
                      file: target.tempFile,
                      name: target.title
                    })
                  }
                />
              )
            )}
          </SortableContext>
        </DndContext>
      </div>

      <GitSection />
      <DocsChecksSection />

      {dialogs}
    </aside>
  )
}
