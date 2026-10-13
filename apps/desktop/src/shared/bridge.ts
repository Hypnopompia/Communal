/** What the preload exposes to the renderer as `window.communal`. */

export type HostState =
  | { state: 'starting' }
  | { state: 'ready'; deviceId: string }
  | { state: 'failed'; message: string };

export interface CommunalBridge {
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  /** The local API lives at this origin; the main process adds the token. */
  apiBase: string;
  hostState(): Promise<HostState>;
  onHostState(cb: (s: HostState) => void): () => void;
  /** Hints that some part of the core's state changed (see `ApiTopic` in core). */
  onTopics(cb: (topics: string[]) => void): () => void;
  defaultDeviceName(): Promise<string>;
  pickFolder(title: string): Promise<string | null>;
  /** Reads a small text file the person picks (a recovery file). */
  pickTextFile(title: string, extensions: string[]): Promise<string | null>;
  saveTextFile(title: string, defaultName: string, text: string): Promise<boolean>;
  openPath(path: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** An agent asked to show a screen (`show_in_app`). */
  onNavigate(cb: (route: { screen: string; [k: string]: unknown }) => void): () => void;
  /** Control from the CLI and AI agents (ADR 0017). */
  agents(): Promise<AgentsState>;
  setAgents(on: boolean): Promise<AgentsState>;
  onAgents(cb: (s: AgentsState) => void): () => void;
  copyText(text: string): Promise<void>;
  /** Auto-update (packaged builds only). */
  onUpdate(cb: (u: UpdateState) => void): () => void;
  installUpdate(): Promise<void>;
  /**
   * Sets this computer aside after it was removed from its account: its identity and Communal
   * data move to a dated backup folder, and the app restarts fresh, ready to be added again.
   */
  startOver(): Promise<void>;
}

export type UpdateState =
  | { state: 'idle' }
  | { state: 'available'; version: string }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

export interface AgentsState {
  enabled: boolean;
  /** Where the control socket listens, while it does. */
  socket: string | null;
  error?: string;
  /** `claude mcp add …` for Claude Code, and an mcpServers block for other MCP clients. */
  claudeCode: string;
  json: string;
}
