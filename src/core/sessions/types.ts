import type { ForgeMode } from "../../types/index.js";

export interface TabMeta {
  workflowRunId?: string;
  id: string;
  label: string;
  activeModel: string;
  sessionId: string;
  planMode: boolean;
  planRequest: string | null;
  coAuthorCommits: boolean;
  forgeMode?: ForgeMode;
  tokenUsage: {
    prompt: number;
    completion: number;
    total: number;
    cacheRead?: number;
    subagentInput?: number;
    subagentOutput?: number;
  };
  messageRange: { startLine: number; endLine: number };
  /** Saved checkpoint git tags for session persistence */
  checkpointTags?: Array<{ index: number; anchorMessageId: string; gitTag: string }>;
  /** Per-tab verbose render. false (default) = rail layout, true = raw stream. */
  verbose?: boolean;
}

export interface SessionMeta {
  id: string;
  title: string;
  /** User-set title that overrides the auto-derived one. */
  customTitle?: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  activeTabId: string;
  forgeMode: ForgeMode;
  tabs: TabMeta[];
}
