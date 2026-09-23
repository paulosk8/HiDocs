import { useSession } from '../store'

/**
 * ¿Dónde va la guía siguiente? (§21)
 *
 * Sale al estrenar guía cuando, sin hacer nada, la siguiente caería en la misma
 * rama que la que se acaba de terminar: una rama elegida a mano se conserva al
 * guardar, y con una rama por módulo es justo lo que se busca. Sin preguntar,
 * la guía nueva se montaba en silencio encima de la anterior y las dos acababan
 * en la misma PR.
 */
export function NextBranchDialog({
  previous,
  finished,
  onClose
}: {
  /** la rama donde iría la siguiente: la de la guía terminada o la editada */
  previous: string
  /** `true` al acabar de registrar una guía; `false` al descartar una edición */
  finished: boolean
  onClose: () => void
}): React.JSX.Element {
  const repo = useSession((s) => s.gitRepo)
  const branchPerGuide = useSession((s) => s.branchPerGuide)
  const setBranchPickerOpen = useSession((s) => s.setBranchPickerOpen)
  const base = repo?.defaultBranch ?? 'la rama por defecto'

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog next-branch" onClick={(e) => e.stopPropagation()}>
        <h3>¿Dónde va la siguiente guía?</h3>
        <p>
          {[
            finished
              ? `La guía que acabas de terminar se registró en ${previous}, y la siguiente iría a la misma rama: las dos acabarían en la misma PR.`
              : `La edición que descartaste era de ${previous}, y lo siguiente que grabes iría a esa rama.`,
            '',
            `Con una rama nueva, la guía nace de ${base} con el nombre docs/<módulo>-<funcionalidad>, y a partir de ahora cada guía estrena la suya.`
          ].join('\n')}
        </p>
        <div className="dialog-actions">
          <button
            className="btn"
            onClick={() => {
              onClose()
              setBranchPickerOpen(true)
            }}
          >
            Elegir otra rama…
          </button>
          <button className="btn" onClick={onClose}>
            Seguir en {previous}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              branchPerGuide()
              onClose()
            }}
          >
            Rama nueva para la guía
          </button>
        </div>
      </div>
    </div>
  )
}
