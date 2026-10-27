/**
 * The document kinds a preview shows, by file extension. Pure, so the desktop renderer imports it
 * too: the chat's preview panel and `GET /v1/files/preview` agree on what is previewable. A new
 * kind is added here and nowhere else.
 */

export type PreviewKind = "markdown" | "html";

export const PREVIEW_KINDS: Record<string, PreviewKind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".html": "html",
  ".htm": "html",
};

/** The preview kind of a path by its extension, or null when it is not previewable. */
export function previewKind(path: string): PreviewKind | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return PREVIEW_KINDS[name.slice(dot).toLowerCase()] ?? null;
}
