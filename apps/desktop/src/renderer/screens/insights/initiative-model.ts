import type {
  FeatureState,
  InitiativeFeature,
  InitiativeListItem,
  InitiativeStatus,
  InitiativeView,
} from "../../client/insights.js";

/** How the Initiatives screen shows statuses; the core stays the authority on what they mean. */

export type Tone = "ok" | "warn" | "err" | "busy" | "muted";

const STATUS: Record<InitiativeStatus, { label: string; tone: Tone }> = {
  decomposing: { label: "splitting", tone: "busy" },
  awaiting_approval: { label: "approve split", tone: "warn" },
  active: { label: "active", tone: "busy" },
  paused: { label: "paused", tone: "warn" },
  completed: { label: "completed", tone: "ok" },
  refused: { label: "refused", tone: "err" },
};

export function initiativeStatus(status: InitiativeStatus): { label: string; tone: Tone } {
  return STATUS[status] ?? { label: status, tone: "muted" };
}

/** The second line of a list item: its status and what happens next. */
export function initiativeLine(item: InitiativeListItem): string {
  const { label } = initiativeStatus(item.status);
  const features = `${item.features} feature${item.features === 1 ? "" : "s"}`;
  if (item.status === "completed" || item.status === "refused") return label;
  if (item.status === "awaiting_approval") return `${label} · ${item.features} proposed`;
  if (item.features === 0) return label;
  return `${label} · ${features}`;
}

export interface FeatureRow {
  mark: string;
  tone: Tone;
  label: string;
  /** Text of the link to the feature's run; null when it has none. */
  link: string | null;
}

const WAITING: readonly FeatureState[] = ["proposed", "waiting", "ready", "stale", "paused"];

export function featureRow(feature: InitiativeFeature): FeatureRow {
  const link = feature.runId ? "Run" : null;
  switch (feature.state) {
    case "accepted":
      return { mark: "✓", tone: "ok", label: "done", link };
    case "in_progress":
      return {
        mark: "⟳",
        tone: "busy",
        label: feature.runStatus ? `in progress · ${feature.runStatus}` : "in progress",
        link,
      };
    case "needs_decision":
      return { mark: "⚑", tone: "warn", label: "needs decision", link: feature.runId && "Decide" };
    case "blocked":
    case "failed":
      return {
        mark: "!",
        tone: "err",
        label: feature.blockers[0] ?? feature.state,
        link,
      };
    case "waiting":
      return {
        mark: "·",
        tone: "muted",
        label:
          feature.dependsOn.length > 0 ? `waits for ${feature.dependsOn.join(", ")}` : "waiting",
        link,
      };
    default:
      return { mark: "·", tone: "muted", label: feature.state.replace("_", " "), link };
  }
}

export interface FeatureCounts {
  done: number;
  inProgress: number;
  needsDecision: number;
  blocked: number;
  waiting: number;
  total: number;
}

export function featureCounts(view: Pick<InitiativeView, "features">): FeatureCounts {
  const count = (states: readonly FeatureState[]): number =>
    view.features.filter((f) => states.includes(f.state)).length;
  return {
    done: count(["accepted"]),
    inProgress: count(["in_progress"]),
    needsDecision: count(["needs_decision"]),
    blocked: count(["blocked", "failed"]),
    waiting: count(WAITING),
    total: view.features.length,
  };
}

/** The pending split approval of an initiative, when one waits for a person. */
export function splitApproval(view: InitiativeView) {
  if (view.status !== "awaiting_approval") return null;
  return view.pendingDecisions.find((d) => d.scope === "initiative") ?? null;
}

/**
 * Whether the initiative can switch to another model now (`POST /v1/initiatives/:id/reroute`):
 * it is not finished, the backend reports its model, and no feature run is executing.
 */
export function canSwitchModel(view: InitiativeView): boolean {
  return (
    view.model !== undefined &&
    view.status !== "completed" &&
    view.status !== "refused" &&
    !view.features.some((f) => f.runStatus === "running")
  );
}
