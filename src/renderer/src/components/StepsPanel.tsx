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
import { StepCard } from './StepCard'
import { ShotModal } from './ShotModal'
import { ConfirmDialog } from './ConfirmDialog'
import { GitSection } from './GitSection'
import { suggestBranchName, suggestCommitMessage } from '../../../shared/naming'

export function StepsPanel(): React.JSX.Element {
  const steps = useSession((s) => s.steps)
  const status = useSession((s) => s.status)
  const attached = useSession((s) => s.attached)
  const reorderSteps = useSession((s) => s.reorderSteps)
  const applyEngineState = useSession((s) => s.applyEngineState)

  const [shot, setShot] = useState<RecordedStep | null>(null)
  const [pendingSave, setPendingSave] = useState<{ untitled: number } | null>(null)
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
              branch: s.gitBranchOverride ?? suggestBranchName(s.meta.module, s.meta.feature),
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
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setPendingSave(null)
    }
  }, [])

  /** Detener y guardar (§8): valida, avisa, y deja guardar igualmente. */
  const stopAndSave = async (): Promise<void> => {
    applyEngineState(await ipc.invoke('recorder:stop'))

    const s = useSession.getState()
    if (!s.steps.length) {
      setProblem('No hay pasos que guardar.')
      return
    }
    const missing: string[] = []
    if (!s.meta.module.trim()) missing.push('módulo')
    if (!s.meta.feature.trim()) missing.push('funcionalidad')
    if (!s.outputDir) missing.push('carpeta de salida')
    if (missing.length) {
      setProblem(`Falta indicar: ${missing.join(', ')}.`)
      return
    }

    const untitled = s.steps.filter((step) => !step.title.trim()).length
    if (untitled > 0) {
      setPendingSave({ untitled })
      return
    }
    await write()
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
  // cualquier diálogo propio exige ocultarlo mientras esté abierto.
  const modalOpen = shot !== null || pendingSave !== null || result !== null || problem !== null
  useEffect(() => {
    void ipc.invoke('viewport:set-visible', !modalOpen)
  }, [modalOpen])

  const record = async (): Promise<void> => {
    setProblem(null)
    setResult(null)
    applyEngineState(await ipc.invoke('recorder:start'))
  }

  return (
    <aside className="panel">
      <div className="panel-header">
        <h2>Pasos</h2>
        <span className="count">{steps.length}</span>
        <div className="controls">
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
        </div>
      </div>

      <div className="panel-body">
        {!attached && status === 'idle' && steps.length === 0 && (
          <p className="empty">
            Abre primero la URL del sistema. Después pulsa <b>●</b> y navega con normalidad: cada
            interacción se convertirá en un paso.
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

      {shot && <ShotModal step={shot} onClose={() => setShot(null)} />}

      {pendingSave && (
        <ConfirmDialog
          title="Hay pasos sin título"
          body={`${pendingSave.untitled} de ${steps.length} pasos no tienen título. Puedes guardar igualmente y completarlos después.`}
          confirmLabel="Guardar de todos modos"
          onConfirm={() => void write()}
          onCancel={() => setPendingSave(null)}
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
    </aside>
  )
}
