/// <reference types="vite/client" />

import type { DocRecorderApi } from '../../shared/ipc-contract'

declare global {
  interface Window {
    docrecorder: DocRecorderApi
  }
}

export {}
