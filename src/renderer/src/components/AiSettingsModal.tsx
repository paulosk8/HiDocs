import { useEffect, useState } from 'react'
import {
  AI_MODELS,
  AI_PROVIDERS,
  AI_PROVIDER_LABEL,
  apiKeyProblem,
  type AiProvider,
  type AiStatus
} from '../../../shared/types'
import { ipc } from '../ipc'
import { useSession } from '../store'

/**
 * Ajustes de la asistencia de IA (§11): proveedor, modelo, clave y si se envía
 * la captura.
 *
 * La clave se escribe aquí y viaja al proceso principal, que la guarda cifrada
 * por el sistema operativo. No vuelve nunca: por eso el campo se vacía al
 * guardarla y lo que se muestra después es solo «configurada».
 */

const KEY_HELP: Record<AiProvider, { url: string; hint: string }> = {
  anthropic: {
    url: 'https://console.anthropic.com/settings/keys',
    hint: 'Consola de Anthropic → Settings → API keys'
  },
  gemini: {
    url: 'https://aistudio.google.com/apikey',
    hint: 'Google AI Studio → Get API key'
  }
}

interface Props {
  onClose: () => void
}

export function AiSettingsModal({ onClose }: Props): React.JSX.Element {
  const status = useSession((s) => s.aiStatus)
  const setAiStatus = useSession((s) => s.setAiStatus)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // La verdad está en el proceso principal, no aquí: al abrir se relee, para no
  // mostrar «sin clave» cuando la configuración cambió después de arrancar.
  useEffect(() => {
    void ipc.invoke('ai:status').then(setAiStatus)
  }, [setAiStatus])

  if (!status) return <></>
  const provider = status.settings.provider
  const configured = status.configured[provider]

  const patch = async (fn: () => Promise<AiStatus>): Promise<void> => {
    setAiStatus(await fn())
  }

  const saveKey = async (): Promise<void> => {
    // El campo está enmascarado: si lo que se pegó no era la clave, aquí es donde
    // hay que decirlo, no al redactar media grabación después.
    const bad = apiKeyProblem(key.trim())
    if (bad) {
      setProblem(bad)
      setSaved(null)
      return
    }
    setSaving(true)
    try {
      setAiStatus(await ipc.invoke('ai:set-key', { provider, key }))
      setSaved(key.trim() ? 'Clave guardada.' : 'Clave borrada.')
      setProblem(null)
      setKey('')
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="ai-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Redacción con IA</h2>
          <button onClick={onClose} aria-label="Cerrar los ajustes de IA">
            ×
          </button>
        </header>

        <div className="ai-body">
          <p className="ai-intro">
            La IA propone el título y la descripción de cada paso a partir de la acción grabada y,
            si lo permites, de su captura. Siempre puedes editar lo que proponga: nada se guarda en
            la documentación hasta que pulsas «Detener y guardar».
          </p>

          <label className="field">
            <span>Proveedor</span>
            <select
              value={provider}
              onChange={(e) =>
                void patch(() =>
                  ipc.invoke('ai:set-settings', { provider: e.target.value as AiProvider })
                )
              }
            >
              {AI_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {AI_PROVIDER_LABEL[p]}
                  {status.configured[p] ? ' — clave configurada' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Modelo</span>
            <select
              value={status.settings.models[provider]}
              onChange={(e) =>
                void patch(() =>
                  ipc.invoke('ai:set-settings', {
                    models: { ...status.settings.models, [provider]: e.target.value }
                  })
                )
              }
            >
              {AI_MODELS[provider].map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>
              Clave de la API {configured ? <b className="ai-ok">· configurada</b> : null}
            </span>
            <input
              className="ai-key"
              type="password"
              value={key}
              placeholder={configured ? 'Escribe una nueva para reemplazarla' : 'Pega aquí tu clave'}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setKey(e.target.value)
                setSaved(null)
                setProblem(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey()
              }}
            />
          </label>
          {problem && <p className="ai-hint ai-problem">{problem}</p>}
          <p className="ai-hint">
            Se obtiene en {KEY_HELP[provider].hint}.{' '}
            <button
              className="link"
              onClick={() => void ipc.invoke('shell:open-external', KEY_HELP[provider].url)}
            >
              Abrir
            </button>
          </p>

          <label className="ai-check">
            <input
              type="checkbox"
              checked={status.settings.useScreenshot}
              onChange={(e) =>
                void patch(() =>
                  ipc.invoke('ai:set-settings', { useScreenshot: e.target.checked })
                )
              }
            />
            Enviar también la captura del paso
          </label>
          <p className="ai-hint">
            Con la captura el modelo ve la pantalla real y describe mejor el contexto; sin ella solo
            recibe la acción, el elemento y el valor, y cuesta bastante menos.
          </p>

          <p className="ai-hint ai-warn">
            {status.encrypted
              ? 'La clave se guarda cifrada por el sistema operativo, fuera del repositorio de documentación.'
              : 'Atención: este sistema no ofrece cifrado, así que la clave se guardará en claro en la carpeta de datos de la aplicación.'}
          </p>
        </div>

        <footer>
          {saved && <span className="ai-saved">{saved}</span>}
          {configured && (
            <button
              className="link"
              onClick={() => void patch(() => ipc.invoke('ai:set-key', { provider, key: '' }))}
            >
              Borrar la clave guardada
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cerrar
          </button>
          <button className="btn primary" disabled={saving || !key.trim()} onClick={() => void saveKey()}>
            {saving ? 'Guardando…' : 'Guardar clave'}
          </button>
        </footer>
      </div>
    </div>
  )
}
