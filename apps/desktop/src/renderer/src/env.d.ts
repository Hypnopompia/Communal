/// <reference types="vite/client" />
import type { CommunalBridge } from '../../shared/bridge';

declare global {
  interface Window {
    communal: CommunalBridge;
  }
}
