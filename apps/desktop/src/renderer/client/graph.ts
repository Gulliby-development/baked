/**
 * The code graph over `/v1/graph*` (`code-graph` capability, docs/desktop/api.md "Code graph").
 * The shapes are those of src/core/intelligence/code-graph-model.ts, which the preview bridge also
 * runs on sample data; an older backend answers 404 and the section shows "needs a newer BAKED".
 */
import type {
  GraphEdge,
  GraphFileDetail,
  GraphFrame,
  GraphUnit,
  GraphView,
} from "../../../../../src/core/intelligence/code-graph-model.js";
import { call } from "./api.js";

export type { GraphEdge, GraphFileDetail, GraphFrame, GraphUnit, GraphView };

export interface GraphRequest {
  expanded: string[];
  tests: boolean;
  typeEdges: boolean;
  reveal?: string;
}

export type GraphAnswer =
  | { state: "ready"; indexing: boolean; view: GraphView }
  | { state: "indexing" | "empty" | "disabled"; indexing: boolean };

export interface GraphFileAnswer extends GraphFileDetail {
  packages: string[];
}

export interface GraphLinkAnswer {
  from: string;
  to: string;
  weight: number;
  typeOnly: boolean;
  names: string[];
  calls: number;
  callSites: { caller: string; callee: string; line: number }[];
  cochanges: number;
  mutual: boolean;
}

const q = encodeURIComponent;

export const graph = {
  view: (key: string, request: GraphRequest) =>
    call<GraphAnswer>(key, "POST", "/v1/graph", request),
  file: (key: string, path: string) =>
    call<GraphFileAnswer>(key, "GET", `/v1/graph/file?path=${q(path)}`),
  link: (key: string, from: string, to: string) =>
    call<GraphLinkAnswer>(key, "GET", `/v1/graph/link?from=${q(from)}&to=${q(to)}`),
  search: (key: string, text: string) =>
    call<{ paths: string[] }>(key, "GET", `/v1/graph/search?q=${q(text)}&limit=8`),
};
