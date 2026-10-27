import { previewKind } from "../../../../../src/core/files/preview-kinds.js";
import { type MockRoute, response } from "./mock-response.js";

/**
 * Project documents of the browser preview, by project key and path: what the sample chats wrote,
 * so the preview panel has something to show. A chat turn of the mock that writes a Markdown or
 * HTML file stores it here too.
 */
const RELEASE_NOTES = `# BAKED 0.6

The chat now shows what it writes. Markdown and HTML documents open **beside the conversation**, and they refresh while the agent keeps editing.

## Highlights

- **Preview panel.** Every Markdown or HTML file the chat writes opens on the right, rendered.
- **Artifacts.** Saved pages and their Vercel deploys open in the same panel.
- **Source view.** Switch any document to its source with one click.

## Numbers

| Area | Before | After |
| --- | ---: | ---: |
| Pull requests | 135 | 162 |
| Median review time | 41 min | 27 min |

> Upgrade with \`baked update\`; your sessions and settings stay as they are.

\`\`\`sh
baked update
baked --version
\`\`\`
`;

const WHATS_NEW = `<!doctype html>
<html><head><meta charset="utf-8"><title>What's new in 0.6</title>
<style>
  body { font-family: "IBM Plex Sans", system-ui, sans-serif; margin: 0; background: #fff8ef; color: #191410; }
  header { background: #ff9d52; border-bottom: 3px solid #191410; padding: 32px 28px; }
  h1 { margin: 0; font-size: 30px; }
  main { padding: 24px 28px; display: grid; gap: 16px; }
  .card { border: 2px solid #191410; border-radius: 8px; box-shadow: 4px 4px 0 #191410; padding: 16px 18px; background: #fff; }
  .card h2 { margin: 0 0 6px; font-size: 18px; }
</style></head>
<body>
  <header><h1>What's new in 0.6</h1><p>Documents open beside the chat.</p></header>
  <main>
    <section class="card"><h2>Preview panel</h2><p>Markdown and HTML the chat writes, rendered on the right.</p></section>
    <section class="card"><h2>Artifacts</h2><p>Saved pages and their deploys in the same place.</p></section>
  </main>
</body></html>
`;

const documents = new Map<string, string>([
  ["docs:docs/release-notes-0.6.md", RELEASE_NOTES],
  ["docs:site/whats-new.html", WHATS_NEW],
]);

export const MOCK_RELEASE_NOTES = RELEASE_NOTES;
export const MOCK_WHATS_NEW = WHATS_NEW;

/** Records a document a mock chat turn wrote. */
export function writeMockDocument(key: string, path: string, text: string): void {
  documents.set(`${key}:${path}`, text);
}

export const fileRoutes: MockRoute = ({ key, method, path, query, body }) => {
  if (path !== "/v1/files/preview" && path !== "/v1/files/open") return undefined;
  const wanted =
    path === "/v1/files/preview"
      ? (query.get("path") ?? "")
      : String((body as { path?: unknown } | null)?.path ?? "");
  const kind = previewKind(wanted);
  if (!kind)
    return response(400, {
      error: { code: "INVALID", message: `${wanted} is not a Markdown or HTML file` },
    });
  const text = documents.get(`${key}:${wanted}`);
  if (text === undefined)
    return response(404, { error: { code: "NOT_FOUND", message: `No file ${wanted}` } });
  if (path === "/v1/files/open" && method === "POST")
    return response(200, { opened: true, path: wanted });
  return response(200, {
    path: wanted,
    kind,
    text,
    bytes: text.length,
    modifiedAt: new Date().toISOString(),
  });
};
