/**
 * Sample answers of the workflow editor (`POST /v1/workflow/editor*`). A small stand-in for
 * src/core/workflows/v2/editor-service.ts: presets open read only, Duplicate makes an editable
 * `ID-custom` copy, gates and transitions can be added, removed, moved and switched, and saving
 * writes nothing but marks the copy saved.
 */
import { type MockRequest, type MockRoute, response } from "./mock-routes.js";
import type {
  EditorOp,
  EditorView,
  GateTarget,
  Outcome,
  ProblemGroup,
  SaveReview,
  StageType,
  WorkingCopy,
} from "./workflow-editor.js";

interface Binding {
  gateId: string;
  mode?: "required" | "advisory";
}
interface MockStage {
  id: string;
  type: StageType;
  produces: string;
  profileId?: string;
  decision?: "human" | "auto";
  gates?: Binding[];
  intervalSeconds?: number;
  timeoutMinutes?: number;
}
interface MockTransition {
  id: string;
  from: string;
  to: string;
  on: Outcome;
  gates: Binding[];
  loop?: { maxIterations: number };
}
interface MockDefinition extends WorkingCopy {
  stages: MockStage[];
  transitions: MockTransition[];
  autoApproval: { enabled: boolean; maxTasks: number } | null;
}

const LIBRARY: Record<string, { type: string; required: boolean; scope: string }> = {
  typecheck: { type: "command", required: true, scope: "feature" },
  lint: { type: "command", required: true, scope: "feature" },
  tests: { type: "command", required: true, scope: "feature" },
  "task-tests": { type: "command", required: true, scope: "task" },
  "correctness-review": { type: "ai-review", required: true, scope: "feature" },
  "manual-signoff": { type: "human", required: true, scope: "transition" },
};
const OUTCOMES: Record<StageType, Outcome[]> = {
  agent: ["passed"],
  tasks: ["passed"],
  approval: ["passed"],
  learn: ["passed"],
  check: ["passed", "failed"],
  wait: ["passed", "failed"],
  review: ["passed", "changes_requested"],
  reflection: ["passed", "changes_requested"],
};

function quick(id: string): MockDefinition {
  return {
    schemaVersion: 2,
    id,
    version: "1.0.0",
    description: "A small, located change: plan, approve, implement, check, review",
    preset: id,
    entry: "plan",
    autoApproval: null,
    stages: [
      { id: "plan", type: "agent", produces: "plan", profileId: "planner" },
      { id: "approve", type: "approval", produces: "decision", decision: "human" },
      { id: "implement", type: "tasks", produces: "changes" },
      {
        id: "checks",
        type: "check",
        produces: "gates",
        gates: [{ gateId: "typecheck" }, { gateId: "lint" }, { gateId: "tests" }],
      },
      {
        id: "review",
        type: "review",
        produces: "review",
        gates: [{ gateId: "correctness-review" }],
      },
    ],
    transitions: [
      { id: "plan-approve", from: "plan", to: "approve", on: "passed", gates: [] },
      { id: "approve-implement", from: "approve", to: "implement", on: "passed", gates: [] },
      {
        id: "implement-checks",
        from: "implement",
        to: "checks",
        on: "passed",
        gates: [{ gateId: "task-tests" }],
      },
      { id: "checks-review", from: "checks", to: "review", on: "passed", gates: [] },
      {
        id: "checks-implement",
        from: "checks",
        to: "implement",
        on: "failed",
        gates: [],
        loop: { maxIterations: 3 },
      },
      { id: "review-done", from: "review", to: "done", on: "passed", gates: [] },
      {
        id: "review-implement",
        from: "review",
        to: "implement",
        on: "changes_requested",
        gates: [],
        loop: { maxIterations: 2 },
      },
    ],
  };
}

const PRESETS = ["sdd", "quick", "quick-fix", "standard", "full", "spike", "review-only", "fix-ci"];
/** Copies saved in this window, by ID. */
const saved = new Map<string, MockDefinition>();

const clone = (d: MockDefinition): MockDefinition => JSON.parse(JSON.stringify(d));
const text = (d: MockDefinition) => `${JSON.stringify(d, null, 2)}\n`;

function opened(id: string): MockDefinition | null {
  const own = saved.get(id);
  if (own) return clone(own);
  return PRESETS.includes(id) ? quick(id) : null;
}

const effective = (b: Binding): "required" | "advisory" =>
  b.mode ?? (LIBRARY[b.gateId]?.required ? "required" : "advisory");
const summary = (gateId: string) => {
  const gate = LIBRARY[gateId];
  return gate
    ? `${gate.type} · ${gate.required ? "required" : "advisory"} · ${gate.scope} · builtin`
    : null;
};

function targetsOf(d: MockDefinition, stage: MockStage): GateTarget[] {
  const own: GateTarget[] = stage.gates ? [{ kind: "stage", stageId: stage.id }] : [];
  return [
    ...own,
    ...d.transitions
      .filter((t) => t.from === stage.id)
      .map((t): GateTarget => ({ kind: "transition", id: t.id })),
  ];
}
function bindings(d: MockDefinition, target: GateTarget): Binding[] {
  if (target.kind === "transition")
    return d.transitions.find((t) => t.id === target.id)?.gates ?? [];
  return d.stages.find((s) => s.id === target.stageId)?.gates ?? [];
}
function restriction(d: MockDefinition, target: GateTarget, gateId: string): string | null {
  const gate = LIBRARY[gateId];
  if (!gate) return "unknown gate";
  if (bindings(d, target).some((b) => b.gateId === gateId)) return "already bound here";
  if (target.kind === "stage") {
    const stage = d.stages.find((s) => s.id === target.stageId);
    if (stage?.type === "check" && gate.type !== "command")
      return "a check stage runs command gates only";
    if (stage?.type === "wait" && gate.type !== "command")
      return "a wait stage polls command gates only";
    if (stage?.type === "review" && gate.type !== "ai-review")
      return "a review stage runs AI review gates only";
    if (gate.scope === "task") return "a task gate runs after each task, not in a stage";
    return null;
  }
  if (gate.type === "ai-review") return "AI review gates belong to a review stage";
  const from = d.stages.find((s) => s.id === d.transitions.find((t) => t.id === target.id)?.from);
  if (gate.scope === "task" && from?.type !== "tasks")
    return `a task gate only follows a tasks stage; ${from?.id ?? "this stage"} is ${from?.type ?? "unknown"}`;
  return null;
}

function problems(d: MockDefinition): ProblemGroup[] {
  const groups: ProblemGroup[] = [];
  for (const s of d.stages)
    if (s.gates && !s.gates.length)
      groups.push({ owner: `stage ${s.id}`, messages: ["needs at least one gate"] });
  for (const s of d.stages)
    if (!d.transitions.some((t) => t.from === s.id && t.on === "passed"))
      groups.push({ owner: `stage ${s.id}`, messages: [`${s.id}: no passed transition`] });
  return groups;
}

function view(d: MockDefinition, from: string, copy: boolean, readOnly: string | null): EditorView {
  const file = saved.get(d.id);
  return {
    id: d.id,
    from,
    copy,
    definition: d,
    readOnly,
    dirty: !file || text(file) !== text(d),
    stages: d.stages.map((stage) => ({
      id: stage.id,
      type: stage.type,
      produces: stage.produces,
      fields: [
        ...(stage.profileId
          ? [
              {
                key: "profile",
                label: "Profile",
                value: stage.profileId,
                hint: "profiles returning plan",
              },
            ]
          : []),
        ...(stage.decision
          ? [
              {
                key: "decision",
                label: "Decision",
                value: stage.decision,
                hint: "human, or auto within limits",
              },
            ]
          : []),
        ...(stage.type === "wait"
          ? [
              {
                key: "interval",
                label: "Interval",
                value: `${stage.intervalSeconds ?? 30}s`,
                hint: "how often its gates run, 5 s to 1 h",
              },
              {
                key: "timeout",
                label: "Timeout",
                value: `${stage.timeoutMinutes ?? 30} min`,
                hint: "then it ends failed, 1 min to 24 h",
              },
            ]
          : []),
        ...d.transitions
          .filter((t) => t.from === stage.id && t.loop)
          .map((t) => ({
            key: `loop:${t.id}`,
            label: `Loop ${t.id}`,
            value: String(t.loop?.maxIterations ?? 1),
            hint: "1 to 5 rounds",
          })),
      ],
      targets: targetsOf(d, stage).map((target) => {
        const transition =
          target.kind === "transition" ? d.transitions.find((t) => t.id === target.id) : undefined;
        return {
          target,
          name: target.kind === "stage" ? `stage ${target.stageId}` : target.id,
          transition: transition
            ? { to: transition.to, on: transition.on, loop: transition.loop?.maxIterations ?? null }
            : null,
          bindings: bindings(d, target).map((b) => ({
            gateId: b.gateId,
            mode: effective(b),
            override: b.mode !== undefined,
            summary: summary(b.gateId),
          })),
          options: Object.keys(LIBRARY)
            .map((gateId) => ({
              gateId,
              summary: summary(gateId) ?? "",
              disabled: restriction(d, target, gateId),
            }))
            .sort((a, b) => Number(a.disabled !== null) - Number(b.disabled !== null)),
        };
      }),
      transitionChoices: {
        to: [...d.stages.map((s) => s.id).filter((id) => id !== stage.id), "done"],
        on: OUTCOMES[stage.type],
        loop: [null, 1, 2, 3, 4, 5],
      },
    })),
    problems: problems(d),
    estimate: saved.has(d.id)
      ? "Estimate: none yet (no earlier run of this workflow)"
      : "Estimate: 0.4M–0.9M tokens (from 4 runs)",
  };
}

const READ_ONLY =
  "Built-in workflows are read only. Duplicate this one as a custom workflow to edit it.";

function setBindings(d: MockDefinition, target: GateTarget, gates: Binding[]): void {
  if (target.kind === "transition") {
    const t = d.transitions.find((x) => x.id === target.id);
    if (t) t.gates = gates;
  } else {
    const s = d.stages.find((x) => x.id === target.stageId);
    if (s) s.gates = gates;
  }
}

function apply(d: MockDefinition, op: EditorOp): string | null {
  switch (op.op) {
    case "addGate": {
      const reason = restriction(d, op.target, op.gateId);
      if (reason) return `${op.gateId}: ${reason}`;
      setBindings(d, op.target, [...bindings(d, op.target), { gateId: op.gateId }]);
      return null;
    }
    case "removeGate":
      setBindings(
        d,
        op.target,
        bindings(d, op.target).filter((_, i) => i !== op.index),
      );
      return null;
    case "moveGate": {
      const list = [...bindings(d, op.target)];
      const a = list[op.index];
      const b = list[op.index + op.delta];
      if (!a || !b) return op.delta < 0 ? "Already first" : "Already last";
      list[op.index] = b;
      list[op.index + op.delta] = a;
      setBindings(d, op.target, list);
      return null;
    }
    case "toggleMode": {
      const list = bindings(d, op.target);
      const b = list[op.index];
      if (!b) return "No gate selected";
      const next = effective(b) === "required" ? "advisory" : "required";
      const fallback = LIBRARY[b.gateId]?.required ? "required" : "advisory";
      list[op.index] = next === fallback ? { gateId: b.gateId } : { gateId: b.gateId, mode: next };
      return null;
    }
    case "addTransition": {
      let id = `${op.from}-${op.to}`;
      for (let n = 2; d.transitions.some((t) => t.id === id); n++) id = `${op.from}-${op.to}-${n}`;
      d.transitions.push({
        id,
        from: op.from,
        to: op.to,
        on: op.on,
        gates: [],
        ...(op.loop ? { loop: { maxIterations: op.loop } } : {}),
      });
      return null;
    }
    case "removeTransition":
      d.transitions = d.transitions.filter((t) => t.id !== op.id);
      return null;
    case "addWaitStage": {
      const out = d.transitions.filter((t) => t.from === op.after && t.on === "passed" && !t.loop);
      const edge = out[0];
      if (!edge || out.length > 1)
        return `${op.after} needs exactly one passed transition to insert a wait stage after it`;
      let id = "wait";
      for (let n = 2; d.stages.some((s) => s.id === id); n++) id = `wait-${n}`;
      const at = d.stages.findIndex((s) => s.id === op.after) + 1;
      d.stages.splice(at, 0, {
        id,
        type: "wait",
        produces: "gates",
        gates: [],
        intervalSeconds: 30,
        timeoutMinutes: 30,
      });
      d.transitions.push({ id: `${id}-passed`, from: id, to: edge.to, on: "passed", gates: [] });
      edge.to = id;
      return null;
    }
    case "removeWaitStage": {
      const stage = d.stages.find((s) => s.id === op.stageId);
      if (stage?.type !== "wait") return "Only a wait stage can be removed here";
      const onward = d.transitions.find((t) => t.from === op.stageId && t.on === "passed");
      if (!onward) return `${op.stageId} has no passed transition to reconnect`;
      d.stages = d.stages.filter((s) => s.id !== op.stageId);
      d.transitions = d.transitions
        .filter((t) => t.from !== op.stageId)
        .map((t) => (t.to === op.stageId ? { ...t, to: onward.to } : t));
      return null;
    }
    case "changeField": {
      const stage = d.stages.find((s) => s.id === op.stageId);
      if (op.key === "decision" && stage?.decision) {
        stage.decision = stage.decision === "human" ? "auto" : "human";
        d.autoApproval = d.stages.some((s) => s.decision === "auto")
          ? { enabled: true, maxTasks: 3 }
          : null;
        return null;
      }
      if (stage?.type === "wait" && (op.key === "interval" || op.key === "timeout")) {
        const steps =
          op.key === "interval"
            ? [5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
            : [1, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440];
        const field = op.key === "interval" ? "intervalSeconds" : "timeoutMinutes";
        const index = Math.max(0, steps.indexOf(stage[field] ?? 30));
        stage[field] = steps[(index + op.delta + steps.length) % steps.length];
        return null;
      }
      if (op.key.startsWith("loop:")) {
        const t = d.transitions.find((x) => x.id === op.key.slice(5));
        if (!t?.loop) return "Not a loop";
        t.loop.maxIterations = ((t.loop.maxIterations - 1 + op.delta + 5) % 5) + 1;
        return null;
      }
      return `No other ${op.key} for ${op.stageId}`;
    }
    case "duplicate":
      return null;
  }
}

interface Body {
  from: string;
  copy?: boolean;
  definition?: MockDefinition;
  op?: EditorOp;
  confirm?: string;
}

const HASH = "9f3c51a2b7d04e6c8a1f2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";

export const editorRoutes: MockRoute = ({ method, path, body }: MockRequest) => {
  if (method !== "POST" || !path.startsWith("/v1/workflow/editor")) return undefined;
  const request = (body ?? {}) as Body;
  const base = opened(request.from);
  if (!base)
    return response(404, {
      error: { code: "NOT_FOUND", message: `Unknown workflow ${request.from}` },
    });
  let copy = request.copy === true;
  const d = clone(request.definition ?? base);
  const readOnly = !copy && !saved.has(request.from) ? READ_ONLY : null;

  if (path === "/v1/workflow/editor") {
    const op = request.op;
    if (!op) return response(200, { view: view(d, request.from, copy, readOnly) });
    if (op.op === "duplicate") {
      let id = `${d.id}-custom`;
      for (let n = 2; saved.has(id); n++) id = `${d.id}-custom-${n}`;
      const duplicate = { ...clone(d), id, preset: "custom", autoApproval: null };
      for (const s of duplicate.stages) if (s.decision) s.decision = "human";
      return response(200, { view: view(duplicate, request.from, true, null) });
    }
    if (readOnly)
      return response(200, { view: view(d, request.from, copy, readOnly), error: readOnly });
    const error = apply(d, op);
    return response(200, {
      view: view(error ? clone(request.definition ?? base) : d, request.from, copy, null),
      ...(error ? { error } : {}),
    });
  }

  const review = ((): SaveReview => {
    if (readOnly) return { kind: "read-only", message: readOnly };
    const groups = problems(d);
    if (groups.length) return { kind: "problems", groups };
    const before = saved.get(d.id);
    if (before && text(before) === text(d)) return { kind: "unchanged" };
    const after = text(d).split("\n").slice(0, 12);
    return {
      kind: "review",
      path: `C:\\Project\\BAKED\\baked\\workflows\\${d.id}.json`,
      text: text(d),
      diff: before ? ["  {", `+   "id": "${d.id}",`, "…"] : after.map((line) => `+ ${line}`),
      gates: d.stages.flatMap((s) =>
        (s.gates ?? []).map(
          (b) =>
            `stage ${s.id}: ${b.gateId} ${effective(b)}${b.mode ? " (set by this workflow)" : ""}`,
        ),
      ),
      autoApproval:
        d.autoApproval && !before?.autoApproval
          ? { hash: HASH, prefix: HASH.slice(0, 12), limits: "at most 3 tasks, 5 files" }
          : null,
    };
  })();
  if (path === "/v1/workflow/editor/review") return response(200, { review });
  if (path !== "/v1/workflow/editor/save") return undefined;
  if (review.kind !== "review")
    return response(200, {
      saved: false,
      review,
      confirmationNeeded: false,
      view: view(d, request.from, copy, readOnly),
    });
  const typed = (request.confirm ?? "").trim().toLowerCase();
  if (review.autoApproval && (typed.length < 12 || !HASH.startsWith(typed)))
    return response(200, {
      saved: false,
      review,
      confirmationNeeded: true,
      view: view(d, request.from, copy, readOnly),
    });
  saved.set(d.id, clone(d));
  copy = false;
  return response(200, { saved: true, path: review.path, view: view(d, d.id, copy, null) });
};
