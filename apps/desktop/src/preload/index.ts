import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { StreamEvent } from "../shared/api.js";
import { type DesktopBridge, IPC } from "../shared/bridge.js";

function listen<T extends unknown[]>(channel: string, listener: (...args: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => listener(...(args as T));
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const streamListeners = new Map<string, (event: StreamEvent) => void>();
ipcRenderer.on(IPC.streamEvent, (_event, id: string, streamEvent: StreamEvent) => {
  streamListeners.get(id)?.(streamEvent);
});
let nextStream = 0;

const bridge: DesktopBridge = {
  platform: process.platform,
  projects: () => ipcRenderer.invoke(IPC.projects),
  refreshProjects: () => ipcRenderer.invoke(IPC.refreshProjects),
  openProject: (key) => ipcRenderer.invoke(IPC.openProject, key),
  closeProject: (key) => ipcRenderer.invoke(IPC.closeProject, key),
  restartProject: (key) => ipcRenderer.invoke(IPC.restartProject, key),
  addFolder: () => ipcRenderer.invoke(IPC.addFolder),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  checkNewProject: (draft) => ipcRenderer.invoke(IPC.checkNewProject, draft),
  createProject: (draft) => ipcRenderer.invoke(IPC.createProject, draft),
  manageProject: (key, action) => ipcRenderer.invoke(IPC.manageProject, key, action),
  renameProject: (key, name) => ipcRenderer.invoke(IPC.renameProject, key, name),
  onProjects: (listener) => listen(IPC.projectsChanged, listener),
  request: (key, method, path, body) => ipcRenderer.invoke(IPC.request, key, method, path, body),
  subscribe: (key, path, listener, lastEventId) => {
    const id = `s${++nextStream}`;
    streamListeners.set(id, listener);
    void ipcRenderer.invoke(IPC.subscribe, id, key, path, lastEventId);
    return () => {
      streamListeners.delete(id);
      void ipcRenderer.invoke(IPC.unsubscribe, id);
    };
  },
  exportChat: (key, sessionId, format) =>
    ipcRenderer.invoke(IPC.exportChat, key, sessionId, format),
  attention: () => ipcRenderer.invoke(IPC.attention),
  onAttention: (listener) => listen(IPC.attentionChanged, listener),
  settings: () => ipcRenderer.invoke(IPC.settings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  onNavigate: (listener) => listen(IPC.navigate, listener),
  windowAction: (action) => ipcRenderer.invoke(IPC.windowAction, action),
  onMaximized: (listener) => {
    void ipcRenderer.invoke(IPC.windowState).then(listener);
    return listen(IPC.windowMaximized, listener);
  },
  voiceStatus: () => ipcRenderer.invoke(IPC.voiceStatus),
  transcribe: (samples, language) => ipcRenderer.invoke(IPC.transcribe, samples, language),
};

contextBridge.exposeInMainWorld("baked", bridge);
