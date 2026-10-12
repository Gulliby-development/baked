/**
 * Long-running work of a project's backend over `GET /v1/progress` (`progress` capability,
 * docs/desktop/api.md "Progress"): opening the project, indexing the code graph, starting a run.
 */
import type { ProgressItem, ProgressTask } from "../../../../../src/core/progress.js";
import { call } from "./api.js";

export type { ProgressItem, ProgressTask };

export const progressApi = {
  list: (key: string) => call<{ items: ProgressItem[] }>(key, "GET", "/v1/progress"),
};
