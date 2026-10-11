/**
 * Announces runs that wait for a person: a pending request (approval, question, manual evidence,
 * recovery, checkpoint, delivery) or a blocked run, such as one whose budget ran out. Each one is
 * announced once, by whichever process appended the event that made it wait
 * (`WorkflowStore.claimAttention`), through a `RunAttention` hook, an optional webhook from
 * `notifications.webhook` and, where the front end allows it, a native desktop notification.
 *
 * Nothing is sent over the network unless a webhook is configured. The webhook payload names the
 * run and what it waits for; it carries no request body, prompt or file content.
 */
import { basename } from "node:path";
import { logBackgroundError } from "../../stores/errors.js";
import type { AppConfig } from "../../types/index.js";
import { runHooks } from "../hooks/index.js";
import { showSystemNotification } from "../platform/notify.js";
import type { WorkflowEvent } from "./schemas.js";
import type { AttentionRow, WorkflowStore } from "./store.js";
import { isAcceptanceRequest } from "./v2/acceptance.js";

/** What a webhook receives, as JSON, for one run that waits. */
export interface RunAttentionPayload {
  event: "run.attention";
  /** The folder name of the workspace. */
  project: string;
  workspace: string;
  runId: string;
  featureId: string;
  /** Null for a blocked run. */
  requestId: string | null;
  /** The request kind, or the reason of a blocked run. */
  kind: string;
  /** False for an advisory acceptance decision, which the run does not wait for. */
  blocking: boolean;
  status: string;
  /** A one-line description, the same as the desktop notification's. */
  message: string;
  createdAt: string;
}

/** Ways to announce; replaced in tests. */
export interface AttentionChannels {
  system(title: string, body: string): Promise<unknown>;
  fetch(url: string, init: RequestInit): Promise<Response>;
}

const defaultChannels: AttentionChannels = {
  system: showSystemNotification,
  fetch: (url, init) => fetch(url, init),
};

const WEBHOOK_TIMEOUT_MS = 10_000;

const KIND_LABELS: Record<string, string> = {
  approval: "approval",
  clarification: "a question",
  manual_evidence: "manual evidence",
  recovery: "a recovery decision",
  checkpoint: "a checkpoint",
  delivery: "delivery approval",
  budget_exhausted: "a budget extension",
};

/** What a run waits for, in words. */
export function attentionMessage(row: Pick<AttentionRow, "kind" | "request_id">): string {
  const label = KIND_LABELS[row.kind];
  if (row.request_id) return `Waiting for ${label ?? row.kind.replaceAll("_", " ")}`;
  return label ? `Blocked: needs ${label}` : `Blocked: ${row.kind.replaceAll("_", " ")}`;
}

export function attentionPayload(workspace: string, row: AttentionRow): RunAttentionPayload {
  return {
    event: "run.attention",
    project: basename(workspace),
    workspace,
    runId: row.run_id,
    featureId: row.feature_id,
    requestId: row.request_id,
    kind: row.kind,
    blocking:
      row.body_json === null || !isAcceptanceRequest({ kind: row.kind, body_json: row.body_json }),
    status: row.status,
    message: attentionMessage(row),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** True for an event after which a run may wait for a person. */
function mayWait(event: WorkflowEvent): boolean {
  return (
    event.type === "request.created" ||
    (event.type === "run.state_changed" && (event.payload as { to?: unknown }).to === "blocked")
  );
}

export class AttentionNotifier {
  /**
   * Whether this front end shows native notifications. Off unless the front end turns it on: the
   * desktop app shows its own from `/v1/attention`, and tests and scripts show none.
   */
  systemNotifications = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Set<Promise<void>>();
  private readonly unobserve: () => void;
  constructor(
    private readonly store: WorkflowStore,
    private readonly workspace: string,
    /** Read on every announcement, so a config change of a running server applies at once. */
    private readonly config: Pick<AppConfig, "notifications">,
    private readonly channels: AttentionChannels = defaultChannels,
  ) {
    this.unobserve = store.observe((event) => {
      if (mayWait(event)) this.schedule();
    });
  }
  /** Checks after the current task, when the transaction that appended the event has committed. */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.track(this.check());
    }, 0);
  }
  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }
  /** Announces every run that waits and was not announced yet. */
  async check(): Promise<void> {
    let rows: AttentionRow[];
    try {
      rows = this.store.claimAttention();
    } catch (error) {
      logBackgroundError("workflow", `Attention check failed: ${message(error)}`);
      return;
    }
    await Promise.all(rows.map((row) => this.announce(attentionPayload(this.workspace, row))));
  }
  private async announce(payload: RunAttentionPayload): Promise<void> {
    await Promise.all([this.hook(payload), this.webhook(payload), this.system(payload)]);
  }
  private async hook(payload: RunAttentionPayload): Promise<void> {
    await runHooks({
      event: "RunAttention",
      cwd: this.workspace,
      matchTarget: payload.kind,
      runAttention: {
        run_id: payload.runId,
        feature_id: payload.featureId,
        request_id: payload.requestId,
        kind: payload.kind,
        blocking: payload.blocking,
        status: payload.status,
      },
    });
  }
  private async webhook(payload: RunAttentionPayload): Promise<void> {
    const webhook = this.config.notifications?.webhook;
    if (!webhook?.url) return;
    if (webhook.blockingOnly && !payload.blocking) return;
    if (!/^https?:\/\//i.test(webhook.url)) {
      logBackgroundError("workflow", "Attention webhook URL must start with http:// or https://");
      return;
    }
    try {
      const response = await this.channels.fetch(webhook.url, {
        method: "POST",
        headers: { ...webhook.headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!response.ok)
        logBackgroundError("workflow", `Attention webhook answered HTTP ${response.status}`);
    } catch (error) {
      logBackgroundError("workflow", `Attention webhook failed: ${message(error)}`);
    }
  }
  private async system(payload: RunAttentionPayload): Promise<void> {
    if (!this.systemNotifications || this.config.notifications?.system === false || !payload.blocking) return;
    await this.channels.system(`${payload.project}: ${payload.featureId}`, payload.message);
  }
  /** Waits for a scheduled check and every announcement in flight; a CLI calls it before exit. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.track(this.check());
    }
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  dispose(): void {
    this.unobserve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
