import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AgentsState, CommunalBridge, HostState, UpdateState } from '../shared/bridge.js';

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const f = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, f);
  return () => ipcRenderer.off(channel, f);
}

/** Values main passes through `webPreferences.additionalArguments` (`--communal-<name>=…`). */
function arg(name: string): string | undefined {
  const prefix = `--communal-${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const bridge: CommunalBridge = {
  version: arg('version') ?? '0.0.0',
  platform:
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
  apiBase: 'communal://api',
  hostState: () => ipcRenderer.invoke('host:state'),
  onHostState: (cb) => subscribe<HostState>('host:state', cb),
  onTopics: (cb) => subscribe<string[]>('core:topics', cb),
  defaultDeviceName: () => ipcRenderer.invoke('app:device-name'),
  pickFolder: (title) => ipcRenderer.invoke('dialog:folder', title),
  pickTextFile: (title, extensions) => ipcRenderer.invoke('dialog:open-text', title, extensions),
  saveTextFile: (title, name, text) => ipcRenderer.invoke('dialog:save-text', title, name, text),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  onNavigate: (cb) => subscribe('ui:navigate', cb),
  agents: () => ipcRenderer.invoke('agents:get'),
  setAgents: (on) => ipcRenderer.invoke('agents:set', on),
  onAgents: (cb) => subscribe<AgentsState>('agents:state', cb),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onUpdate: (cb) => subscribe<UpdateState>('update:state', cb),
  installUpdate: () => ipcRenderer.invoke('update:install'),
};

contextBridge.exposeInMainWorld('communal', bridge);
