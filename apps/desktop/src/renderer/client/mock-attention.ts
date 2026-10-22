import type { AttentionItem, RunSnapshot } from "../../shared/api.js";
import type { DeliveryBody, RunRequest, RunWithRequests, SessionPrompts } from "./attention.js";
import { type MockRoute, response } from "./mock-response.js";

const MINUTE = 60_000;
const now = Date.now();

function runItem(
  projectKey: string,
  projectName: string,
  featureId: string,
  kind: string,
  minutesAgo: number,
  blocking = true,
): AttentionItem {
  return {
    source: "run",
    runId: `att-${featureId}`,
    featureId,
    sessionId: null,
    title: null,
    status: blocking ? "waiting" : "running",
    requestId: `req-${featureId}-${kind}`,
    kind,
    blocking,
    createdAt: now - minutesAgo * MINUTE,
    projectKey,
    projectName,
  };
}

function chatItem(
  projectKey: string,
  projectName: string,
  sessionId: string,
  title: string,
  kind: string,
  minutesAgo: number,
): AttentionItem {
  return {
    source: "chat",
    runId: null,
    featureId: null,
    sessionId,
    title,
    status: "waiting",
    requestId: `prompt-${sessionId}`,
    kind,
    blocking: true,
    createdAt: now - minutesAgo * MINUTE,
    projectKey,
    projectName,
  };
}

let items: AttentionItem[] = [
  runItem("baked", "BAKED", "usage-totals", "approval", 12),
  runItem("baked", "BAKED", "headless-json", "clarification", 4),
  runItem("baked", "BAKED", "locale-validation", "delivery", 20),
  chatItem("baked", "BAKED", "s-exit-codes", "Exit codes for blocked runs", "question", 2),
  chatItem("site", "site", "s-pricing", "Pricing page copy", "outside-cwd", 9),
  {
    source: "initiative",
    runId: null,
    featureId: null,
    sessionId: null,
    initiativeId: "billing",
    title: "Billing v2",
    status: "waiting",
    requestId: "req-billing-split",
    kind: "split_approval",
    blocking: true,
    createdAt: now - 45 * MINUTE,
    projectKey: "baked",
    projectName: "BAKED",
  },
  runItem("baked", "BAKED", "settings-dark-mode", "manual_evidence", 40, false),
];
/** Every sample item, answered or not, so a run answers after its item left the list. */
const ALL = [...items];
const listeners = new Set<(items: AttentionItem[]) => void>();

/** The sample "Needs you" list; answering an item removes it, as the real stream would. */
export const mockAttention = {
  items: (): AttentionItem[] => items,
  subscribe(listener: (items: AttentionItem[]) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function resolve(requestId: string): void {
  items = items.filter((i) => i.requestId !== requestId);
  for (const listener of listeners) listener(items);
}

const DELIVERY: DeliveryBody = {
  planId: "plan-1",
  operations: ["commit", "push", "pull_request"],
  remote: { name: "origin", url: "git@github.com:example/baked.git" },
  branch: "baked/locale-validation-3f9a21c0",
  base: { commit: "4be1f02", branch: "main" },
  files: [
    "modify scripts/validate-locales.ts",
    "modify .github/workflows/ci.yml",
    "add tests/locales.test.ts",
  ],
  excluded: [{ path: ".env.local", reason: "secret" }],
  userChanges: ["README.md"],
  commitMessage: "Validate every locale against en.json in CI",
  pullRequest: {
    repository: "example/baked",
    title: "Validate every locale against en.json in CI",
    base: "main",
    draft: true,
  },
};

const BODIES: Record<string, unknown> = {
  approval: {
    executionMode: "worktree",
    worktree: { branch: "baked/usage-totals", userChangesInScope: ["src/core/usage.ts"] },
    writes: [
      { path: "src/core/usage.ts", action: "modify" },
      { path: "src/headless/usage.ts", action: "add" },
      { path: "tests/usage.test.ts", action: "add" },
    ],
    profiles: ["implementer", "tester"],
    checks: [{ id: "typecheck" }, { id: "test" }, { id: "lint" }],
    deferredCriteria: ["AC-4"],
  },
  clarification: {
    questions: [
      {
        id: "Q1",
        question: "Which exit code should a blocked run return in --json mode?",
        blocking: true,
      },
      { id: "Q2", question: "Should the code differ when a person must answer?", blocking: false },
    ],
  },
  delivery: DELIVERY,
  manual_evidence: { criterionId: "AC-3", question: "Toggling the theme feels instant" },
};

function runOf(item: AttentionItem, revision = 7): RunWithRequests {
  const request: RunRequest = {
    id: item.requestId ?? "",
    kind: item.kind,
    status: "pending",
    digest: `digest-${item.kind}`,
    body_json: JSON.stringify(BODIES[item.kind] ?? {}),
  };
  const snapshot: RunSnapshot = {
    runId: item.runId ?? "",
    featureId: item.featureId ?? "",
    status: item.kind === "delivery" ? "completed" : item.status,
    revision,
    eventSeq: 40,
    stageId: item.kind === "approval" ? "approve" : "plan",
    tokenUsage: 240_000,
    activeMs: 12 * MINUTE,
    estimatedCostUsd: 0.42,
    pendingRequestIds: [request.id],
  };
  return { ...snapshot, requests: [request] };
}

const SESSIONS: Record<string, SessionPrompts> = {
  "s-exit-codes": {
    id: "s-exit-codes",
    title: "Exit codes for blocked runs",
    prompts: [
      {
        id: "prompt-s-exit-codes",
        createdAt: now - 2 * MINUTE,
        kind: "question",
        question: "Use exit code 3 for a run that waits for a person?",
        allowSkip: true,
        options: [
          { label: "Yes, 3", value: "3" },
          { label: "Reuse 2", value: "2", description: "Same as a failed run" },
        ],
      },
    ],
  },
  "s-pricing": {
    id: "s-pricing",
    title: "Pricing page copy",
    prompts: [
      {
        id: "prompt-s-pricing",
        createdAt: now - 9 * MINUTE,
        kind: "outside-cwd",
        tool: "write_file",
        path: "C:\\Work\\shared\\pricing.json",
      },
    ],
  },
};

export const attentionRoutes: MockRoute = ({ method, path, body }) => {
  const run = /^\/v1\/workflow\/runs\/(att-[^/]+)(?:\/(.+))?$/.exec(path);
  if (run) {
    const item = ALL.find((i) => i.runId === run[1]);
    const action = run[2];
    if (!item) return response(404, { error: { code: "NOT_FOUND", message: "Run not found" } });
    if (method === "GET" && !action) return response(200, runOf(item));
    const requestId = (body as { requestId?: string } | undefined)?.requestId;
    if (action === "approve" || action === "resume") {
      if (item.kind !== "delivery" && action === "resume" && item.requestId)
        resolve(item.requestId);
      return response(200, runOf(item, 8));
    }
    if (action === "reject" || action === "answer") {
      if (requestId) resolve(requestId);
      return response(200, runOf(item, 8));
    }
    if (action === "deliver")
      return response(200, { requestId: item.requestId, digest: "digest-delivery", revision: 9 });
    if (action === "deliver/execute") {
      if (item.requestId) resolve(item.requestId);
      return response(200, {
        branch: DELIVERY.branch,
        commit: "9d1c2e7",
        pullRequest: { url: "https://github.com/example/baked/pull/42", number: 42 },
      });
    }
    return undefined;
  }
  const session = /^\/v1\/sessions\/([^/]+)(?:\/prompts\/([^/]+))?$/.exec(path);
  const detail = session?.[1] ? SESSIONS[session[1]] : undefined;
  if (!session || !detail) return undefined;
  if (method === "GET" && !session[2]) return response(200, detail);
  if (method === "POST" && session[2]) {
    resolve(session[2]);
    return response(200, { resolved: true });
  }
  return undefined;
};
