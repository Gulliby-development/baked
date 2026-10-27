/**
 * Project documents over `/v1/files*`: a Markdown or HTML file of the project for the chat's
 * preview panel, and opening one with the system's default app. Shapes follow
 * `docs/desktop/api.md#file-preview`.
 */
import type { PreviewKind } from "../../../../../src/core/files/preview-kinds.js";
import { call } from "./api.js";

export interface PreviewDocument {
  path: string;
  kind: PreviewKind;
  text: string;
  bytes: number;
  modifiedAt: string;
}

export const files = {
  preview: (key: string, path: string) =>
    call<PreviewDocument>(key, "GET", `/v1/files/preview?path=${encodeURIComponent(path)}`),
  open: (key: string, path: string) =>
    call<{ opened: boolean; path: string }>(key, "POST", "/v1/files/open", { path }),
};
