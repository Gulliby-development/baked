import type { BakeMode, ChatEffort, ChatMessage } from "../../types/index.js";

export interface TabMeta {
  workflowRunId?: string;
  id: string;
  label: string;
  activeModel: string;
  sessionId: string;
  planMode: boolean;
  planRequest: string | null;
  coAuthorCommits: boolean;
  bakeMode?: BakeMode;
  /** The conversation's reasoning effort; absent or `default` follows the global setting. */
  effort?: ChatEffort;
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
  /**
   * Turns an undo dropped, oldest first, with their messages, so a redo can put them back. Cleared
   * when a new turn starts.
   */
  redoTurns?: Array<{ index: number; anchorMessageId: string; messages: ChatMessage[] }>;
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
  bakeMode: BakeMode;
  tabs: TabMeta[];
  /** The project (`baked/project.json`) of `cwd` when the session was saved. */
  projectId?: string;
  /** `coordinator` for the project's coordinator chat; absent for an ordinary session. */
  kind?: "coordinator";
  /** The session that launched this one, such as the project coordinator. */
  parentId?: string;
}
