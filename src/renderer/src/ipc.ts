import type { DocRecorderApi } from '../../shared/ipc-contract'

/** Acceso tipado al puente expuesto por el preload. */
export const ipc: DocRecorderApi = window.docrecorder
