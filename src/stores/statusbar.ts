import { execFile } from "node:child_process";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { CompactionStrategy } from "../core/compaction/types.js";
import { getIntelligenceChildPids } from "../core/intelligence/index.js";
import { matchPricing } from "../core/llm/pricing.js";
import { IS_WIN } from "../core/platform/index.js";
import type { WaitingElsewhere } from "../core/projects/switcher.js";

export { isModelFree } from "../core/llm/pricing.js";

interface PerModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  subagentInput: number;
  subagentOutput: number;
  lastStepInput: number;
  lastStepOutput: number;
  lastStepCacheRead: number;
  modelBreakdown: Record<string, PerModelUsage>;
}

/** Compute session cost in USD.
 *  prompt = uncached input only (noCache tokens).
 *  cacheWrite and cacheRead tracked separately with their own rates.
 *  @internal — exported for testing only; production code uses computeTotalCostFromBreakdown */
export function computeCost(usage: TokenUsage, modelId: string): number {
  const p = matchPricing(modelId);
  const uncached = usage.prompt + usage.subagentInput;
  const totalOutput = usage.completion + usage.subagentOutput;
  return (
    (uncached / 1e6) * p.input +
    (usage.cacheWrite / 1e6) * p.cacheWrite +
    (usage.cacheRead / 1e6) * p.cacheRead +
    (totalOutput / 1e6) * p.output
  );
}

/** Compute total cost from per-model breakdown. More accurate than computeCost when router mixes models. */
export function computeTotalCostFromBreakdown(breakdown: Record<string, PerModelUsage>): number {
  let total = 0;
  for (const [modelId, usage] of Object.entries(breakdown)) {
    const p = matchPricing(modelId);
    const cost =
      ((usage.input ?? 0) / 1e6) * p.input +
      ((usage.cacheWrite ?? 0) / 1e6) * p.cacheWrite +
      ((usage.cacheRead ?? 0) / 1e6) * p.cacheRead +
      ((usage.output ?? 0) / 1e6) * p.output;
    if (Number.isFinite(cost)) total += cost;
  }
  return total;
}

/** Compute cost for a single model from the breakdown. */
export function computeModelCost(modelId: string, usage: PerModelUsage): number {
  const p = matchPricing(modelId);
  const cost =
    ((usage.input ?? 0) / 1e6) * p.input +
    ((usage.cacheWrite ?? 0) / 1e6) * p.cacheWrite +
    ((usage.cacheRead ?? 0) / 1e6) * p.cacheRead +
    ((usage.output ?? 0) / 1e6) * p.output;
  return Number.isFinite(cost) ? cost : 0;
}

/** Accumulate tokens for a specific model in the breakdown. Returns a new breakdown object. */
export function accumulateModelUsage(
  breakdown: Record<string, PerModelUsage>,
  modelId: string,
  delta: Partial<PerModelUsage>,
): Record<string, PerModelUsage> {
  const prev = breakdown[modelId] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    ...breakdown,
    [modelId]: {
      input: prev.input + (delta.input ?? 0),
      output: prev.output + (delta.output ?? 0),
      cacheRead: prev.cacheRead + (delta.cacheRead ?? 0),
      cacheWrite: prev.cacheWrite + (delta.cacheWrite ?? 0),
    },
  };
}

export const ZERO_USAGE: TokenUsage = {
  prompt: 0,
  completion: 0,
  total: 0,
  cacheRead: 0,
  cacheWrite: 0,
  subagentInput: 0,
  subagentOutput: 0,
  lastStepInput: 0,
  lastStepOutput: 0,
  lastStepCacheRead: 0,
  modelBreakdown: {},
};

interface ProcessRss {
  mainMB: number;
  lspMB: number;
}

const ZERO_PROCESS_RSS: ProcessRss = { mainMB: 0, lspMB: 0 };

export interface LastDispatchAgent {
  agentId: string;
  role?: string;
  modelId?: string;
  tier?: string;
  task?: string;
  toolUses: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  succeeded?: boolean;
  state: "running" | "done" | "error";
}

export interface LastDispatchSnapshot {
  parentToolCallId: string;
  startedAt: number;
  finishedAt?: number;
  totalAgents: number;
  completedAgents: number;
  agents: Record<string, LastDispatchAgent>;
}

interface StatusBarState {
  tokenUsage: TokenUsage;
  activeModel: string;
  contextTokens: number;
  contextWindow: number;
  chatChars: number;
  chatCharsAtSnapshot: number;
  subagentChars: number;
  rssMB: number;
  processRss: ProcessRss;
  compacting: boolean;
  compactElapsed: number;
  compactionStrategy: CompactionStrategy;
  v2Slots: number;
  /** True when the user is browsing a past checkpoint */
  browsingCheckpoint: boolean;
  /** Most recent dispatch (cleared/replaced on each new dispatch-start). */
  lastDispatch: LastDispatchSnapshot | null;
  /** Display name of the folder this process works in; empty until the header reads it. */
  projectName: string;
  /** Requests and blocked runs waiting in other known projects. */
  waitingElsewhere: WaitingElsewhere;
  setProject: (name: string, waitingElsewhere?: WaitingElsewhere) => void;
  setTokenUsage: (usage: TokenUsage, modelId?: string) => void;
  resetTokenUsage: () => void;
  setContext: (contextTokens: number, chatChars: number) => void;
  setBrowsingCheckpoint: (v: boolean) => void;
  setContextWindow: (tokens: number) => void;
  setSubagentChars: (chars: number) => void;
  setRssMB: (mb: number) => void;
  setProcessRss: (rss: ProcessRss) => void;
  setCompacting: (v: boolean) => void;
  setCompactElapsed: (s: number) => void;
  setCompactionStrategy: (s: CompactionStrategy) => void;
  setV2Slots: (n: number) => void;
  startDispatch: (parentToolCallId: string, totalAgents: number) => void;
  upsertDispatchAgent: (
    parentToolCallId: string,
    agent: Partial<LastDispatchAgent> & { agentId: string },
  ) => void;
  finishDispatch: (parentToolCallId: string) => void;
}

export const useStatusBarStore = create<StatusBarState>()(
  subscribeWithSelector((set) => ({
    tokenUsage: { ...ZERO_USAGE },
    activeModel: "none",
    contextTokens: 0,
    contextWindow: 0,
    chatChars: 0,
    chatCharsAtSnapshot: 0,
    subagentChars: 0,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    processRss: {
      ...ZERO_PROCESS_RSS,
      mainMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    compacting: false,
    compactElapsed: 0,
    compactionStrategy: "v2",
    v2Slots: 0,
    browsingCheckpoint: false,
    lastDispatch: null,
    projectName: "",
    waitingElsewhere: { waiting: 0, projects: 0 },

    setProject: (projectName, waitingElsewhere) =>
      set(waitingElsewhere ? { projectName, waitingElsewhere } : { projectName }),
    setTokenUsage: (usage, modelId) =>
      set({ tokenUsage: usage, ...(modelId ? { activeModel: modelId } : {}) }),
    resetTokenUsage: () => set({ tokenUsage: { ...ZERO_USAGE } }),
    setContext: (contextTokens, chatChars) =>
      set({
        contextTokens,
        chatChars,
        chatCharsAtSnapshot: contextTokens > 0 ? chatChars : 0,
        subagentChars: 0,
      }),
    setContextWindow: (tokens) => set({ contextWindow: tokens }),
    setSubagentChars: (chars) => set({ subagentChars: chars }),
    setRssMB: (mb) => set({ rssMB: mb }),
    setProcessRss: (rss) =>
      set({
        processRss: rss,
        rssMB: Math.round(rss.mainMB + rss.lspMB),
      }),
    setCompacting: (v) => set({ compacting: v, compactElapsed: 0 }),
    setCompactElapsed: (s) => set({ compactElapsed: s }),
    setCompactionStrategy: (s) => set({ compactionStrategy: s }),
    setV2Slots: (n) => set({ v2Slots: n }),
    setBrowsingCheckpoint: (v) => set({ browsingCheckpoint: v }),

    startDispatch: (parentToolCallId, totalAgents) =>
      set({
        lastDispatch: {
          parentToolCallId,
          startedAt: Date.now(),
          totalAgents,
          completedAgents: 0,
          agents: {},
        },
      }),
    upsertDispatchAgent: (parentToolCallId, agent) =>
      set((s) => {
        const cur = s.lastDispatch;
        if (!cur || cur.parentToolCallId !== parentToolCallId) return s;
        const prev = cur.agents[agent.agentId] ?? {
          agentId: agent.agentId,
          toolUses: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          state: "running" as const,
        };
        const merged: LastDispatchAgent = { ...prev, ...agent };
        const wasRunning = prev.state === "running";
        const nowDone = merged.state === "done" || merged.state === "error";
        const completedAgents =
          wasRunning && nowDone ? cur.completedAgents + 1 : cur.completedAgents;
        return {
          lastDispatch: {
            ...cur,
            completedAgents,
            agents: { ...cur.agents, [agent.agentId]: merged },
          },
        };
      }),
    finishDispatch: (parentToolCallId) =>
      set((s) => {
        const cur = s.lastDispatch;
        if (!cur || cur.parentToolCallId !== parentToolCallId) return s;
        return { lastDispatch: { ...cur, finishedAt: Date.now() } };
      }),
  })),
);

export function resetStatusBarStore(): void {
  if (memPollTimer) {
    clearInterval(memPollTimer);
    memPollTimer = null;
    memPollStarted = false;
  }
  footprintCacheMB = null;
  footprintCacheAt = 0;
  footprintRefreshInFlight = false;
  useStatusBarStore.setState({
    tokenUsage: { ...ZERO_USAGE },
    activeModel: "none",
    contextTokens: 0,
    contextWindow: 0,
    chatChars: 0,
    chatCharsAtSnapshot: 0,
    subagentChars: 0,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    processRss: {
      ...ZERO_PROCESS_RSS,
      mainMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    compacting: false,
    compactElapsed: 0,
    compactionStrategy: "v2",
    v2Slots: 0,
  });
}

interface PidGroup {
  lsp: number[];
}

async function collectPidGroups(): Promise<PidGroup> {
  return {
    lsp: await getIntelligenceChildPids(),
  };
}

function getPerPidRssKB(pids: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (pids.length === 0) return Promise.resolve(result);
  if (IS_WIN) {
    return new Promise((resolve) => {
      execFile(
        "wmic",
        [
          "process",
          "where",
          `(${pids.map((p) => `ProcessId=${String(p)}`).join(" or ")})`,
          "get",
          "ProcessId,WorkingSetSize",
          "/format:csv",
        ],
        (err, stdout) => {
          if (err) {
            resolve(result);
            return;
          }
          for (const line of stdout.split("\n")) {
            const parts = line.trim().split(",");
            const pidStr = parts[1];
            const bytesStr = parts[2];
            if (pidStr && bytesStr) {
              const pid = Number.parseInt(pidStr, 10);
              const bytes = Number.parseInt(bytesStr, 10);
              if (!Number.isNaN(pid) && !Number.isNaN(bytes)) {
                result.set(pid, bytes / 1024);
              }
            }
          }
          resolve(result);
        },
      );
    });
  }
  return new Promise((resolve) => {
    execFile("ps", ["-p", pids.join(","), "-o", "pid=,rss="], (err, stdout) => {
      if (err) {
        resolve(result);
        return;
      }
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const pidStr = parts[0];
        const kbStr = parts[1];
        if (pidStr && kbStr) {
          const pid = Number.parseInt(pidStr, 10);
          const kb = Number.parseInt(kbStr, 10);
          if (!Number.isNaN(pid) && !Number.isNaN(kb)) {
            result.set(pid, kb);
          }
        }
      }
      resolve(result);
    });
  });
}

/**
 * Resolve the main process's true memory footprint.
 *
 * `process.memoryUsage().rss` and `ps -o rss` both exclude macOS-compressed
 * pages — they'll report 4 GB while Activity Monitor shows 9 GB because
 * the OS silently compresses cold heap. We need the "physical footprint"
 * number, which matches what Activity Monitor displays.
 *
 * On macOS: read phys_footprint via /usr/bin/footprint, which queries the
 * Mach task_info VM bookkeeping directly. Crucially it does NOT stall the
 * target task. The previous sampler (vmmap --summary) walked the entire VM
 * map and suspended the target for ~300ms per call — even fire-and-forget
 * off the await path, the *target* (us) froze on every sample (#102). The
 * 30s TTL cache is kept as belt-and-braces against fork cost, and the poll
 * never awaits the sampler; it returns the freshest value we already have
 * (rss until the first refresh lands).
 *
 * On Linux/Windows: RSS already includes everything meaningful.
 */
const FOOTPRINT_TTL_MS = 30_000;
let footprintCacheMB: number | null = null;
let footprintCacheAt = 0;
let footprintRefreshInFlight = false;

async function getMainFootprintMB(): Promise<number> {
  const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (process.platform !== "darwin") return rssMB;

  const now = Date.now();
  if (footprintCacheMB === null || now - footprintCacheAt >= FOOTPRINT_TTL_MS) {
    // Fire-and-forget — never await vmmap on the poll path.
    void refreshFootprintMB();
  }
  return footprintCacheMB ?? rssMB;
}

async function refreshFootprintMB(): Promise<void> {
  if (footprintRefreshInFlight) return;
  footprintRefreshInFlight = true;
  try {
    const mb = await macFootprintMB(process.pid);
    // Stamp the time either way: on failure, back off for the TTL instead of
    // hammering vmmap on every subsequent poll.
    footprintCacheAt = Date.now();
    if (mb != null) footprintCacheMB = mb;
  } finally {
    footprintRefreshInFlight = false;
  }
}

function macFootprintMB(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/footprint",
      [String(pid)],
      { timeout: 2000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        // "    phys_footprint: 813 MB" — unit varies (KB/MB/GB)
        const m = stdout.match(/phys_footprint:\s+([\d.]+)\s*([KMGT])B/);
        if (!m?.[1] || !m[2]) {
          resolve(null);
          return;
        }
        const n = Number.parseFloat(m[1]);
        const unit = m[2];
        const mb =
          unit === "G"
            ? n * 1024
            : unit === "M"
              ? n
              : unit === "K"
                ? n / 1024
                : unit === "T"
                  ? n * 1024 * 1024
                  : n;
        resolve(Math.round(mb));
      },
    );
  });
}

let memPollStarted = false;
let memPollTimer: ReturnType<typeof setInterval> | null = null;
export function startMemoryPoll(intervalMs = 2000) {
  if (memPollStarted) return;
  memPollStarted = true;
  memPollTimer = setInterval(async () => {
    const mainMB = await getMainFootprintMB();
    const groups = await collectPidGroups();
    const allPids: number[] = [];
    allPids.push(...groups.lsp);

    if (allPids.length === 0) {
      useStatusBarStore.getState().setProcessRss({ mainMB, lspMB: 0 });
      return;
    }
    getPerPidRssKB(allPids).then((rssMap) => {
      let lspMB = 0;
      for (const pid of groups.lsp) {
        lspMB += Math.round((rssMap.get(pid) ?? 0) / 1024);
      }
      useStatusBarStore.getState().setProcessRss({
        mainMB,
        lspMB,
      });
    });
  }, intervalMs);
}
