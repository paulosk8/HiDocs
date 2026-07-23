import { join } from 'node:path'
import type { Locator, Page } from 'playwright-core'
import { waitForStability } from './stability'
import type {
  DocSession,
  DocStep,
  FlowAction,
  RegenStepResult,
  SelectorCandidate
} from '../../shared/types'

/**
 * Runner de regeneración: re-ejecuta el flujo grabado de una funcionalidad y
 * vuelve a capturar sus pantallas. Sirve cuando el sistema documentado cambia de
 * interfaz: en vez de volver a grabar a mano, se reproduce el flujo y se
 * actualizan las capturas.
 *
 * Reutiliza la sesión autenticada del visor (por eso el usuario inicia sesión
 * antes). Localiza cada elemento probando sus `selectorCandidates` en orden
 * (fallback); si ninguno lo encuentra, el paso se MARCA como fallido —conserva su
 * captura anterior— y se sigue con el resto.
 */

export type { RegenStepResult }

const HIGHLIGHT_COLOR = '#FF5722'
const LOCATE_TIMEOUT_MS = 4000
const ACTION_TIMEOUT_MS = 6000

/** Acciones a re-ejecutar para un paso: las fundidas del formulario, o la suya. */
function stepActions(step: DocStep): FlowAction[] {
  if (step.mergedActions && step.mergedActions.length > 0) return step.mergedActions
  const action: FlowAction = {
    order: step.order,
    action: step.action,
    selectorCandidates: step.selectorCandidates,
    url: step.url
  }
  if (step.value !== undefined) action.value = step.value
  return [action]
}

/** Localiza un elemento probando los candidatos en orden; null si ninguno vale. */
async function locate(page: Page, candidates: SelectorCandidate[]): Promise<Locator | null> {
  for (const candidate of candidates) {
    try {
      const loc = page.locator(candidate.value).first()
      await loc.waitFor({ state: 'visible', timeout: LOCATE_TIMEOUT_MS })
      return loc
    } catch {
      // siguiente candidato
    }
  }
  return null
}

async function perform(page: Page, loc: Locator, action: FlowAction): Promise<void> {
  const value = action.value ?? ''
  switch (action.action) {
    case 'click':
      await loc.click({ timeout: ACTION_TIMEOUT_MS })
      break
    case 'fill':
      await loc.fill(value, { timeout: ACTION_TIMEOUT_MS })
      break
    case 'select':
      // El valor grabado suele ser la etiqueta de la opción; si no, su value.
      try {
        await loc.selectOption({ label: value }, { timeout: ACTION_TIMEOUT_MS })
      } catch {
        await loc.selectOption(value, { timeout: ACTION_TIMEOUT_MS })
      }
      break
    case 'press':
      await loc.press('Enter', { timeout: ACTION_TIMEOUT_MS })
      break
    case 'submit':
      await loc.evaluate((el) => (el as HTMLElement).closest('form')?.requestSubmit())
      break
    case 'navigate':
      if (action.url) await page.goto(action.url, { waitUntil: 'domcontentloaded' })
      break
  }
}

/** Dibuja el resaltado sobre el elemento, captura, y lo quita (sin dejar rastro). */
async function captureStep(
  page: Page,
  targetDir: string,
  relScreenshot: string,
  loc: Locator | null
): Promise<void> {
  const box = loc ? await loc.boundingBox().catch(() => null) : null
  if (box) {
    await page
      .evaluate(
        ([b, color]) => {
          const o = document.createElement('div')
          o.id = '__docrec_regen_hl'
          Object.assign(o.style, {
            position: 'fixed',
            left: `${b.x}px`,
            top: `${b.y}px`,
            width: `${b.width}px`,
            height: `${b.height}px`,
            border: `3px solid ${color}`,
            borderRadius: '6px',
            boxSizing: 'border-box',
            zIndex: '2147483647',
            pointerEvents: 'none'
          })
          document.body.appendChild(o)
        },
        [box, HIGHLIGHT_COLOR] as const
      )
      .catch(() => undefined)
  }
  await page.screenshot({ path: join(targetDir, relScreenshot), type: 'png' })
  await page
    .evaluate(() => document.getElementById('__docrec_regen_hl')?.remove())
    .catch(() => undefined)
}

/**
 * Re-ejecuta el flujo de `session` en `page` (autenticada) y sobrescribe las
 * capturas en `targetDir`. Devuelve un resultado por paso.
 */
export async function regenerateSession(
  page: Page,
  session: DocSession,
  targetDir: string,
  onProgress?: (result: RegenStepResult) => void
): Promise<RegenStepResult[]> {
  const results: RegenStepResult[] = []

  await page.goto(session.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
  await waitForStability(page).catch(() => undefined)

  for (const step of session.steps) {
    const actions = stepActions(step)
    let lastLoc: Locator | null = null
    let failure = ''

    for (const action of actions) {
      if (action.action === 'navigate') {
        await perform(page, page.locator('body'), action)
        await waitForStability(page).catch(() => undefined)
        continue
      }
      const loc = await locate(page, action.selectorCandidates)
      if (!loc) {
        failure = `No se encontró el elemento (${action.selectorCandidates[0]?.value ?? 'sin selector'}).`
        break
      }
      try {
        await perform(page, loc, action)
        lastLoc = loc
        await waitForStability(page).catch(() => undefined)
      } catch (err) {
        failure = err instanceof Error ? err.message.split('\n')[0] : String(err)
        break
      }
    }

    let result: RegenStepResult
    if (failure) {
      // Se conserva la captura anterior del paso y se marca el fallo.
      result = { order: step.order, title: step.title, status: 'failed', detail: failure }
    } else {
      await captureStep(page, targetDir, step.screenshot, lastLoc)
      result = { order: step.order, title: step.title, status: 'ok', detail: '' }
    }
    results.push(result)
    onProgress?.(result)
  }

  return results
}
