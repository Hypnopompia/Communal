/** Messages between the Electron main process and the core host (`utilityProcess`). */
import type { UiRoute } from '@communal/core';

export interface HostInit {
  t: 'init';
  dataDir: string;
  downloadsDir: string;
  /** This device's Ed25519 secret key, decrypted by main with `safeStorage`. */
  deviceSecret: Uint8Array;
  /** The account root secret on a restored device (ADR 0014). */
  rootSecret?: Uint8Array;
  /** Bearer token for the local API on 127.0.0.1. */
  token: string;
  version: string;
  /** Dev builds against the Docker dev stack accept its self-signed hub certificate. */
  insecureTls: boolean;
  upnp: boolean;
  /** Serve the API on the local socket for the CLI and AI agents (ADR 0017). */
  control: boolean;
}

export type ToHost = HostInit | { t: 'stop' } | { t: 'control'; on: boolean };

export type FromHost =
  | { t: 'ready'; url: string; deviceId: string }
  /** A restore produced a root secret; main keeps it with `safeStorage`. */
  | { t: 'save-root'; secret: Uint8Array }
  | { t: 'fatal'; message: string }
  /** The local control socket: where it listens, or why it couldn't. */
  | { t: 'control'; socket: string | null; error?: string }
  /** An agent asked to show a screen (`POST /v1/ui/show`). */
  | { t: 'ui'; route: UiRoute }
  | { t: 'stopped' };
