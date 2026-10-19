import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AcceptanceRow } from "../../../../../../src/core/workflows/acceptance-rows-model.js";
import { bridge } from "../../client/bridge.js";
import {
  type ArtifactEntry,
  type DefinitionSummary,
  errorText,
  type RunDetailStatus,
  type RunRow,
  type RunUsage,
  runs,
  type WorkflowEvent,
} from "../../client/runs.js";
import type { WorkflowLine } from "../../client/start.js";
import type { AcceptanceGate, WalkRecord } from "./acceptance.js";
import {
  latestByPath,
  type PipelineStage,
  pipeline,
  type Review,
  type RunTrace,
  refetchFor,
  replay,
  type SavedEstimate,
  type Spec,
  stageProgress,
  type TaskCount,
  type TaskGraph,
  taskCount,
} from "./model.js";

/** What a run's artifacts say, read from their latest revisions. */
export interface RunArtifacts {
  list: ArtifactEntry[];
  spec: Spec | null;
  plan: string | null;
  graph: TaskGraph | null;
  rows?: AcceptanceRow[];
  estimate: SavedEstimate | null;
  /** The latest routing record: the run model and the routed stages. */
  routing: RoutingRecord | null;
  /** What starting each declared check found before the run began; null for a run without it. */
  preflight: CheckSmoke[] | null;
  reviews: Review[];
  walks: WalkRecord[];
  gates: AcceptanceGate[];
}

// Artifact content never changes for an ID, so it is read once per session.
const contents = new Map<string, Promise<string>>();
function read(key: string, runId: string, id: string): Promise<string> {
  const cacheKey = `${key}:${runId}:${id}`;
  let found = contents.get(cacheKey);
  if (!found) {
    found = runs.readArtifact(key, runId, id);
    found.catch(() => contents.delete(cacheKey));
    contents.set(cacheKey, found);
  }
  return found;
}
async function readJson<T>(key: string, runId: string, entry: ArtifactEntry | undefined) {
  if (!entry) return null;
  try {
    return JSON.parse(await read(key, runId, entry.id)) as T;
  } catch {
    return null;
  }
}

/** One entry of `preflight/checks.json`. */
export interface CheckSmoke {
  checkId: string;
  executable: string;
  required: boolean;
  status: "started" | "not_found" | "cannot_start" | "not_probed";
  detail?: string;
}

/** The parts of `routing.json` the run screen shows. */
export interface RoutingRecord {
  runModel: string;
  stages: Record<string, { model: string; source: string }>;
  profiles: Record<string, { model: string; source: string }>;
}

export async function loadArtifacts(
  key: string,
  runId: string,
  findingArtifacts: readonly string[] = [],
): Promise<RunArtifacts> {
  const list = await runs.artifacts(key, runId);
  const latest = latestByPath(list);
  const walkEntries = [...latest.values()].filter((a) =>
    /^acceptance\/[^/]+\/[^/]+\/walk\.json$/.test(a.path),
  );
  const reviewIds = [...new Set(findingArtifacts)];
  const [spec, planText, graph, estimate, routing, preflight, gates, walks, reviews, rows] =
    await Promise.all([
      readJson<Spec>(key, runId, latest.get("spec.json")),
      latest.has("plan.md")
        ? read(key, runId, latest.get("plan.md")?.id ?? "").catch(() => null)
        : Promise.resolve(null),
      readJson<TaskGraph>(key, runId, latest.get("tasks.json")),
      readJson<SavedEstimate>(key, runId, latest.get("estimates/start.json")),
      readJson<RoutingRecord>(key, runId, latest.get("routing.json")),
      readJson<{ checks: CheckSmoke[] }>(key, runId, latest.get("preflight/checks.json")),
      readJson<AcceptanceGate[]>(key, runId, latest.get("definition/gates.json")),
      Promise.all(walkEntries.map((e) => readJson<WalkRecord>(key, runId, e))),
      Promise.all(
        reviewIds.map(async (id) => {
          const entry = list.find((a) => a.id === id);
          return entry ? readJson<Review>(key, runId, entry) : null;
        }),
      ),
      readJson<{ rows: AcceptanceRow[] }>(key, runId, latest.get("rows.json")),
    ]);
  return {
    list,
    spec,
    plan: planText,
    graph,
    ...(Array.isArray(rows?.rows) ? { rows: rows.rows } : {}),
    estimate,
    routing: routing && typeof routing.runModel === "string" ? routing : null,
    preflight: Array.isArray(preflight?.checks) ? preflight.checks : null,
    gates: Array.isArray(gates) ? gates : [],
    walks: walks.filter((w): w is WalkRecord => w !== null),
    reviews: reviews.filter((r): r is Review => r !== null && Array.isArray(r.findings)),
  };
}

const definitionCache = new Map<string, Promise<DefinitionSummary[]>>();
export function definitions(key: string): Promise<DefinitionSummary[]> {
  let found = definitionCache.get(key);
  if (!found) {
    found = runs.definitions(key).catch(() => []);
    definitionCache.set(key, found);
  }
  return found;
}
export async function definitionOf(
  key: string,
  estimate: SavedEstimate | null,
): Promise<DefinitionSummary | null> {
  const id = estimate?.workflowId;
  if (!id) return null;
  return (await definitions(key)).find((d) => d.id === id) ?? null;
}
export async function stagesOf(
  key: string,
  estimate: SavedEstimate | null,
): Promise<string[] | null> {
  return (await definitionOf(key, estimate))?.stages ?? null;
}

// ---------------------------------------------------------------------------------------------
// One run, live

export interface RunData {
  status: RunDetailStatus;
  artifacts: RunArtifacts;
  usage: RunUsage | null;
  stages: string[] | null;
  /** The workflow's stages with their contracts and repair loops, when the backend sends them. */
  line: WorkflowLine | null;
  capabilities: string[];
}

export interface LiveRun {
  data: RunData | null;
  trace: RunTrace;
  error: string | null;
  /** Reads the snapshot again, e.g. after an action. */
  refresh: () => Promise<void>;
}

const REFETCH_DELAY_MS = 300;

/**
 * Loads a run and keeps it current: the run's event stream is open while the screen is, events
 * are replayed into the trace, and the snapshot, artifacts or usage are read again when an event
 * says they changed (`refetchFor`).
 */
export function useRun(key: string, runId: string): LiveRun {
  const [data, setData] = useState<RunData | null>(null);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const eventsRef = useRef<WorkflowEvent[]>([]);
  const trace = useMemo(() => replay(events), [events]);
  const findingsRef = useRef<string[]>([]);
  findingsRef.current = [...trace.findings.values()];

  const refresh = useCallback(async () => {
    try {
      const status = await runs.status(key, runId);
      setData((d) => (d ? { ...d, status } : d));
    } catch (e) {
      setError(errorText(e));
    }
  }, [key, runId]);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: WorkflowEvent[] = [];
    setData(null);
    setEvents([]);
    setError(null);
    eventsRef.current = [];

    const flush = async (): Promise<void> => {
      const batch = pending;
      pending = [];
      const need = refetchFor(batch);
      try {
        const [status, artifacts, usage] = await Promise.all([
          need.status ? runs.status(key, runId) : null,
          need.artifacts ? loadArtifacts(key, runId, findingsRef.current) : null,
          need.usage ? runs.usage(key, runId).catch(() => null) : null,
        ]);
        if (!live) return;
        setData((d) =>
          d
            ? {
                ...d,
                ...(status ? { status } : {}),
                ...(artifacts ? { artifacts } : {}),
                ...(usage ? { usage } : {}),
              }
            : d,
        );
      } catch (e) {
        if (live) setError(errorText(e));
      }
    };

    void (async () => {
      try {
        const [status, history, usage, capabilities] = await Promise.all([
          runs.status(key, runId),
          runs.events(key, runId),
          runs.usage(key, runId).catch(() => null),
          runs.capabilities(key).catch(() => []),
        ]);
        const seen = replay(history);
        const artifacts = await loadArtifacts(key, runId, [...seen.findings.values()]);
        const definition = await definitionOf(key, artifacts.estimate);
        if (!live) return;
        eventsRef.current = history;
        setEvents(history);
        setData({
          status,
          artifacts,
          usage,
          stages: definition?.stages ?? null,
          line: definition?.line ?? null,
          capabilities,
        });
        const lastSeq = history.at(-1)?.seq ?? 0;
        stop = bridge.subscribe(
          key,
          runs.eventsPath(runId),
          (message) => {
            if (!message.data || message.event === "error") return;
            let event: WorkflowEvent;
            try {
              event = JSON.parse(message.data) as WorkflowEvent;
            } catch {
              return;
            }
            const last = eventsRef.current.at(-1)?.seq ?? 0;
            if (typeof event.seq !== "number" || event.seq <= last) return;
            eventsRef.current = [...eventsRef.current, event];
            setEvents(eventsRef.current);
            pending.push(event);
            clearTimeout(timer);
            timer = setTimeout(() => void flush(), REFETCH_DELAY_MS);
          },
          lastSeq ? String(lastSeq) : undefined,
        );
      } catch (e) {
        if (live) setError(errorText(e));
      }
    })();
    return () => {
      live = false;
      clearTimeout(timer);
      stop?.();
    };
  }, [key, runId]);

  return { data, trace, error, refresh };
}

// ---------------------------------------------------------------------------------------------
// Run list rows

export interface RunBrief {
  title: string | null;
  stage: { index: number; total: number };
  /** The run's stages in order with their state, for the line on the run list. */
  pipeline: PipelineStage[];
  tasks: TaskCount;
  updatedAt: string | null;
  hasAcceptance: boolean;
}

const briefs = new Map<string, Promise<RunBrief>>();
/** Title, stage x/y, tasks and last activity of a listed run, cached by its event sequence. */
export function runBrief(key: string, run: RunRow): Promise<RunBrief> {
  const cacheKey = `${key}:${run.runId}:${run.eventSeq}`;
  let found = briefs.get(cacheKey);
  if (!found) {
    found = (async () => {
      const [events, artifacts] = await Promise.all([
        runs.events(key, run.runId),
        loadArtifacts(key, run.runId),
      ]);
      const trace = replay(events);
      const stages = pipeline(await stagesOf(key, artifacts.estimate), trace, run);
      return {
        title: artifacts.spec?.title ?? null,
        stage: stageProgress(stages, run.stageId),
        pipeline: stages,
        tasks: taskCount(artifacts.graph, trace),
        updatedAt: trace.lastAt,
        hasAcceptance:
          artifacts.walks.length > 0 ||
          trace.criteria.size > 0 ||
          [...trace.requests.values()].some((r) => r.kind === "manual_evidence"),
      };
    })();
    found.catch(() => briefs.delete(cacheKey));
    briefs.set(cacheKey, found);
  }
  return found;
}

/** Briefs of the listed runs, read a few at a time. */
export function useBriefs(key: string, list: readonly RunRow[] | null): Map<string, RunBrief> {
  const [result, setResult] = useState<Map<string, RunBrief>>(new Map());
  useEffect(() => {
    if (!list) return;
    let live = true;
    const queue = [...list];
    const worker = async (): Promise<void> => {
      for (let run = queue.shift(); run && live; run = queue.shift()) {
        const current = run;
        try {
          const brief = await runBrief(key, current);
          if (live) setResult((m) => new Map(m).set(current.runId, brief));
        } catch {
          // A run whose details cannot be read still lists with its snapshot fields.
        }
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => {
      live = false;
    };
  }, [key, list]);
  return result;
}
