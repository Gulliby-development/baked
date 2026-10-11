import type { AppConfig } from "../../types/index.js";
import { ContextManager } from "./manager.js";

/**
 * One lazily created root context per process. Chat sessions and workflow steps build their own
 * context managers on top of it, so they share one repository map, memory store and
 * code-intelligence worker (and the language servers it spawns) instead of starting one each.
 */
export class SharedRootContext {
  private pending: Promise<ContextManager> | undefined;

  constructor(private readonly create: () => Promise<ContextManager>) {}

  /** A root for `workspace` that starts its own intelligence worker on first use. */
  static forWorkspace(workspace: string, config: AppConfig): SharedRootContext {
    return new SharedRootContext(() =>
      ContextManager.createAsync(workspace, undefined, {
        repoMapEnabled: config.repoMap !== false,
      }),
    );
  }

  /** Creates the root on the first call; later calls share it. A failed creation is retried. */
  get(): Promise<ContextManager> {
    if (!this.pending) {
      const created = this.create();
      this.pending = created;
      created.catch(() => {
        if (this.pending === created) this.pending = undefined;
      });
    }
    return this.pending;
  }

  /** True once `get` has started creating the root. */
  get started(): boolean {
    return this.pending !== undefined;
  }

  /** Resolves once the root has closed its databases; a later `get` creates a new root. */
  async dispose(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const context = await pending.catch(() => undefined);
    await context?.dispose({ preserveSharedIO: true });
  }
}
