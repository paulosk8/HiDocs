import { useCallback, useEffect, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
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
import { useSession } from '../store'
import { invalidateBranches } from '../useBranches'
import { StepCard } from './StepCard'
import { ShotModal } from './ShotModal'
import { ConfirmDialog } from './ConfirmDialog'
import { GitSection } from './GitSection'
import { suggestBranchName, suggestCommitMessage } from '../../../shared/naming'
import { useAiDraft } from '../useAiDraft'

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
  // El informe del runner se muestra al terminar; durante el replay el visor
  // debe quedar VISIBLE (se ve la reproducción y las capturas salen con tamaño).
  const runnerReportOpen = useSession((s) => s.runnerPhase === 'done')
  const groupFormFields = useSession((s) => s.groupFormFields)
  const setGroupFormFields = useSession((s) => s.setGroupFormFields)
  const aiOpen = useSession((s) => s.aiOpen)
  const aiBusyIds = useSession((s) => s.aiBusyIds)
  const aiProgress = useSession((s) => s.aiProgress)
  const aiError = useSession((s) => s.aiError)
  const setAiError = useSession((s) => s.setAiError)
  const { draft } = useAiDraft()

  const [shot, setShot] = useState<RecordedStep | null>(null)
  const [pendingSave, setPendingSave] = useState<{ untitled: number } | null>(null)
  const [pendingCommit, setPendingCommit] = useState<{
    branch: string
    message: string
    untitled: number
  } | null>(null)
  const [result, setResult] = useState<SaveResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = steps.findIndex((s) => s.id === active.id)
    const to = steps.findIndex((s) => s.id === over.id)
    if (from >= 0 && to >= 0) reorderSteps(from, to)
  }

  // Los manejadores asíncronos leen el estado con `getState()`: detener la
  // grabación puede emitir todavía un último paso, y una copia capturada en el
  // render lo perdería.
  const write = useCallback(async (): Promise<void> => {
    const s = useSession.getState()
    setBusy(true)
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
              baseBranch: s.gitBaseBranch ?? undefined
            }
          : undefined
      })
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
      void ipc.invoke('draft:clear')
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setPendingSave(null)
    }
  }, [startFreshSession])

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
    runnerReportOpen ||
    aiOpen ||
    aiError !== null
  useEffect(() => {
    void ipc.invoke('viewport:set-visible', !modalOpen)
  }, [modalOpen])

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
        title="Detener y guardar"
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
      {shot && <ShotModal step={shot} onClose={() => setShot(null)} />}

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
          body={`${pendingSave.untitled} de ${steps.length} pasos no tienen título. Puedes guardar igualmente y completarlos después.`}
          confirmLabel="Guardar de todos modos"
          onConfirm={() => void write()}
          onCancel={() => setPendingSave(null)}
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
          <span className="count" title={`${steps.length} paso(s)`}>
            {steps.length}
          </span>
          <div className="controls controls-vertical">{controls}</div>
        </div>
        {dialogs}
      </aside>
    )
  }

  return (
    <aside className="panel">
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
        <span className="count">{steps.length}</span>
        <label
          className="group-toggle"
          title="Une los campos que RELLENAS o SELECCIONAS de un mismo formulario en un solo paso (una captura en vez de una por campo). No afecta a los clics."
        >
          <input
            type="checkbox"
            checked={groupFormFields}
            onChange={(e) => setGroupFormFields(e.target.checked)}
          />
          agrupar campos
        </label>
        {/* Solo se redactan los pasos que van al manual: pagar tokens por un paso
            excluido de la documentación no tendría sentido. */}
        <button
          className="btn btn-ai"
          disabled={aiBusyIds.length > 0 || !steps.some((s) => s.includeInDocs)}
          title="Propone título y descripción para todos los pasos incluidos en la documentación"
          onClick={() =>
            void draft(steps.filter((s) => s.includeInDocs).map((s) => s.id))
          }
        >
          {aiBusyIds.length > 0
            ? `Redactando ${aiProgress ? `${aiProgress.done}/${aiProgress.total}` : ''}…`
            : '✨ Redactar todos'}
        </button>
        <div className="controls">{controls}</div>
      </div>

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
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {steps.map((step) => (
              <StepCard key={step.id} step={step} onOpenShot={setShot} />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <GitSection />

      {dialogs}
    </aside>
  )
}
