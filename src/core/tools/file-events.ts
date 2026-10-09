import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Origin of an edit — the tab and (optionally) subagent that produced it.
 * Set via runWithEditOrigin around tool-execution scopes. Listeners use this
 * to distinguish "self" edits from cross-tab / subagent edits so the bake-map
 * delta only surfaces a session header when the origin is something other
 * than this listener's own tabId.
 */
export interface EditOrigin {
  tabId?: string | null;
  agentId?: string | null;
  agentLabel?: string | null;
}

type FileEditCallback = (absPath: string, content: string, origin: EditOrigin | null) => void;
type FileReadCallback = (absPath: string) => void;
type VoidCallback = () => void;

const editListeners = new Set<FileEditCallback>();
const readListeners = new Set<FileReadCallback>();
const cacheResetListeners = new Set<VoidCallback>();

const _editOriginScope = new AsyncLocalStorage<EditOrigin>();

/**
 * Run a callback with an explicit edit origin. Any emitFileEdited calls
 * issued from within `fn` (sync or async) will see this origin via
 * AsyncLocalStorage. Nested scopes inherit unless overridden.
 */
export function runWithEditOrigin<T>(origin: EditOrigin, fn: () => T): T {
  return _editOriginScope.run(origin, fn);
}

/** Read the current edit origin without entering a new scope. */
export function getEditOrigin(): EditOrigin | null {
  return _editOriginScope.getStore() ?? null;
}

export function onFileEdited(cb: FileEditCallback): () => void {
  editListeners.add(cb);
  return () => {
    editListeners.delete(cb);
  };
}

export function onFileRead(cb: FileReadCallback): () => void {
  readListeners.add(cb);
  return () => {
    readListeners.delete(cb);
  };
}

/** Subscribe to cache reset events (fired on /clear, compaction, etc.) */
export function onCacheReset(cb: VoidCallback): () => void {
  cacheResetListeners.add(cb);
  return () => {
    cacheResetListeners.delete(cb);
  };
}

export function emitFileEdited(absPath: string, content: string): void {
  const origin = _editOriginScope.getStore() ?? null;
  for (const cb of editListeners) cb(absPath, content, origin);
}

export function emitFileRead(absPath: string): void {
  for (const cb of readListeners) cb(absPath);
}

/** Signal all read caches to clear (conversation reset, compaction, etc.) */
export function emitCacheReset(): void {
  for (const cb of cacheResetListeners) cb();
}
