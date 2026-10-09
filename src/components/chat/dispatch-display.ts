import { useEffect, useRef, useState } from "react";
import {
  type AgentStatsEvent,
  type MultiAgentEvent,
  onAgentStats,
  onMultiAgentEvent,
  onSubagentStep,
  type SubagentStep,
} from "../../core/agents/subagent-events.js";
import type { AgentInfo, MultiAgentState } from "./multi-agent-display.js";
import { applyMultiAgentEvent } from "./multi-agent-display.js";
import { RENDER_DEBOUNCE } from "./ToolCallDisplay.js";

interface DispatchDisplayData {
  steps: SubagentStep[];
  progress: MultiAgentState | null;
  stats: Map<string, AgentStatsEvent>;
}

const EMPTY_DISPATCH: DispatchDisplayData = {
  steps: [],
  progress: null,
  stats: new Map(),
};

interface ParsedTask {
  agentId: string;
  role?: string;
  task?: string;
  dependsOn?: string[];
}

export function useDispatchDisplay(
  parentId: string | null,
  maxSteps: number,
  fallbackTotal: number,
  seedTasks?: ParsedTask[],
): DispatchDisplayData {
  const stepsRef = useRef<SubagentStep[]>([]);
  const progressRef = useRef<MultiAgentState | null>(null);
  const statsRef = useRef<Map<string, AgentStatsEvent>>(new Map());
  const dirtyRef = useRef(false);
  const maxStepsRef = useRef(maxSteps);
  maxStepsRef.current = maxSteps;
  const fallbackRef = useRef(fallbackTotal);
  fallbackRef.current = fallbackTotal;

  const [, setTick] = useState(0);

  const seedTasksRef = useRef(seedTasks);
  seedTasksRef.current = seedTasks;
  const seededRef = useRef(false);

  useEffect(() => {
    if (!parentId) return;
    stepsRef.current = [];
    statsRef.current = new Map();
    dirtyRef.current = false;
    seededRef.current = false;
    progressRef.current = null;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleTick = () => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (dirtyRef.current) {
          dirtyRef.current = false;
          setTick((n) => n + 1);
        }
      }, RENDER_DEBOUNCE);
    };

    const unsub1 = onSubagentStep((step) => {
      if (step.parentToolCallId !== parentId) return;
      const prev = stepsRef.current;
      const existing = prev.findIndex(
        (s) => s.toolName === step.toolName && s.args === step.args && s.state === "running",
      );
      if (existing >= 0 && step.state !== "running") {
        const next = [...prev];
        next[existing] = step;
        stepsRef.current = next;
      } else {
        const next = [...prev, step];
        const max = maxStepsRef.current;
        stepsRef.current = next.length > max ? next.slice(-max) : next;
      }
      dirtyRef.current = true;
      scheduleTick();
    });

    const unsub2 = onMultiAgentEvent((event: MultiAgentEvent) => {
      if (event.parentToolCallId !== parentId) return;
      progressRef.current = applyMultiAgentEvent(progressRef.current, event, fallbackRef.current);
      dirtyRef.current = true;
      scheduleTick();
    });

    const unsub3 = onAgentStats((event) => {
      if (event.parentToolCallId !== parentId) return;
      const next = new Map(statsRef.current);
      next.set(event.agentId, event);
      statsRef.current = next;
      dirtyRef.current = true;
      scheduleTick();
    });

    return () => {
      unsub1();
      unsub2();
      unsub3();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [parentId]);

  // Seed pending agents when dispatch args are parsed (may arrive after effect above)
  useEffect(() => {
    if (!parentId || !seedTasks || seedTasks.length === 0 || seededRef.current) return;
    seededRef.current = true;
    const prev = progressRef.current;
    const agents = new Map<string, AgentInfo>(prev?.agents);
    for (const t of seedTasks) {
      if (!agents.has(t.agentId)) {
        agents.set(t.agentId, {
          role: t.role ?? "explore",
          task: t.task ?? "",
          state: "pending",
          dependsOn: t.dependsOn,
        });
      }
    }
    progressRef.current = {
      totalAgents: Math.max(seedTasks.length, prev?.totalAgents ?? 0),
      agents,
      findingCount: prev?.findingCount ?? 0,
    };
    dirtyRef.current = true;
    setTick((n) => n + 1);
  }, [parentId, seedTasks]);

  if (!parentId) return EMPTY_DISPATCH;
  return {
    steps: stepsRef.current,
    progress: progressRef.current,
    stats: statsRef.current,
  };
}
