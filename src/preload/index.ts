import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  type DocRecorderApi,
  type IpcEventChannel,
  type IpcInvokeChannel
} from '../shared/ipc-contract'

/**
 * Puente único entre el renderer y el main. Solo se aceptan canales declarados
 * en el contrato: cualquier otro nombre se rechaza aquí, no en main.
 */
const api: DocRecorderApi = {
  invoke: (channel, ...args) => {
    if (!IPC_INVOKE_CHANNELS.includes(channel as IpcInvokeChannel)) {
      return Promise.reject(new Error(`Canal IPC no permitido: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel as string, ...args)
  },
  on: (channel, listener) => {
    if (!IPC_EVENT_CHANNELS.includes(channel as IpcEventChannel)) {
      throw new Error(`Canal de evento no permitido: ${String(channel)}`)
    }
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(payload as never)
    }
    ipcRenderer.on(channel as string, handler)
    return () => {
      ipcRenderer.removeListener(channel as string, handler)
    }
  }
}

contextBridge.exposeInMainWorld('docrecorder', api)
