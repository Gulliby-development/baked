/**
 * Project documents a front end can preview: Markdown and HTML files inside the project. The
 * desktop chat's preview panel reads them through `GET /v1/files/preview`; every surface that
 * previews a document takes its size limit and project confinement from here, and its kinds from
 * ./preview-kinds.ts.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { displayPath, isInside, realPath } from "../projects/paths.js";
import { type PreviewKind, previewKind } from "./preview-kinds.js";

export { PREVIEW_KINDS, type PreviewKind, previewKind } from "./preview-kinds.js";

/** Larger files are refused: a preview is for documents, not data dumps. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export interface PreviewDocument {
  /** The path relative to the project, with forward slashes. */
  path: string;
  kind: PreviewKind;
  text: string;
  bytes: number;
  modifiedAt: string;
}

export class PreviewError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}

/** The absolute file of a previewable project path; throws a PreviewError otherwise. */
export function previewFile(workspace: string, path: string): string {
  const kind = previewKind(path);
  if (!kind) throw new PreviewError("INVALID", `${path} is not a Markdown or HTML file`);
  const file = realPath(resolve(workspace, path));
  if (!isInside(realPath(workspace), file))
    throw new PreviewError("INVALID", `${path} is outside the project`);
  // The real path may end in another extension when the name is a link to another file.
  if (previewKind(file) !== kind)
    throw new PreviewError("INVALID", `${path} is not a Markdown or HTML file`);
  return file;
}

/** Reads a Markdown or HTML file of the project for a preview. */
export function readPreview(workspace: string, path: string): PreviewDocument {
  const file = previewFile(workspace, path);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(file);
  } catch {
    throw new PreviewError("NOT_FOUND", `No file ${path}`);
  }
  if (!stat.isFile()) throw new PreviewError("NOT_FOUND", `No file ${path}`);
  if (stat.size > PREVIEW_MAX_BYTES)
    throw new PreviewError(
      "TOO_LARGE",
      `${path} is ${Math.round(stat.size / 1024)} KB; previews stop at ${PREVIEW_MAX_BYTES / 1024 / 1024} MB`,
    );
  return {
    path: displayPath(workspace, file),
    kind: previewKind(file) as PreviewKind,
    text: readFileSync(file, "utf8"),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}
