/**
 * The BAKED-styled page the desktop app shows when it fails to start (#2686), instead of the
 * native error box. The page is self-contained (inline CSS with the BAKED tokens, no script, a CSP
 * that allows nothing else) and loads in a sandboxed window without a preload. Its two buttons are
 * links to the `baked-startup:` scheme: the main process intercepts the navigation and copies the
 * details or quits, so the page needs no IPC. Electron-free so the tests can import it.
 */

export type StartupErrorAction = "copy" | "quit";

const ACTION_SCHEME = "baked-startup:";

/** The text the page shows and Copy details copies: the stack when there is one. */
export function startupErrorDetails(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return String(error);
}

/** The action a navigation from the error page asks for, or null for any other URL. */
export function startupErrorAction(url: string): StartupErrorAction | null {
  if (url === `${ACTION_SCHEME}copy`) return "copy";
  if (url === `${ACTION_SCHEME}quit`) return "quit";
  return null;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** CSS the main process inserts after copying, so the page confirms it without a script. */
export const STARTUP_ERROR_COPIED_CSS = ".copied { visibility: visible; }";

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #191410; --bg-code: #100c09; --text: #fff4e5; --text-3: #c2ac96;
  --line-strong: #68513f; --ink: #000000; --on-fill: #191410;
  --fill-accent: #ff9d52; --fill-err: #ff8e86; --err: #ff8e86;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #fffaf2; --bg-code: #f1e3d0; --text: #302015; --text-3: #71563f;
    --line-strong: #aa825d; --ink: #302015; --on-fill: #302015;
    --fill-accent: #ff9d52; --fill-err: #ffa69f; --err: #b02e25;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--text);
  font: 14px/1.5 "IBM Plex Sans", system-ui, sans-serif;
  display: flex; flex-direction: column; gap: 16px; padding: 24px;
}
.badge {
  align-self: flex-start; background: var(--fill-err); color: var(--on-fill);
  border: 2px solid var(--ink); border-radius: 6px; box-shadow: 2px 2px 0 0 var(--ink);
  font: 700 11px/1 "IBM Plex Mono", ui-monospace, monospace; letter-spacing: 0.08em;
  text-transform: uppercase; padding: 5px 8px;
}
h1 { margin: 0; font-size: 22px; line-height: 1.2; }
p { margin: 0; color: var(--text-3); }
pre {
  flex: 1; min-height: 0; margin: 0; overflow: auto; padding: 12px 14px;
  background: var(--bg-code); color: var(--err);
  border: 2px solid var(--ink); border-radius: 6px; box-shadow: 4px 4px 0 0 var(--ink);
  font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
  user-select: text;
}
.actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
a.button {
  display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px;
  border: 2px solid var(--ink); border-radius: 6px; box-shadow: 4px 4px 0 0 var(--ink);
  background: var(--bg); color: var(--text); font-weight: 600; text-decoration: none; cursor: pointer;
}
a.button.primary { background: var(--fill-accent); color: var(--on-fill); }
a.button:hover { transform: translate(-1px, -1px); box-shadow: 5px 5px 0 0 var(--ink); }
a.button:active { transform: translate(2px, 2px); box-shadow: 2px 2px 0 0 var(--ink); }
a.button:focus-visible { outline: 2px solid var(--fill-accent); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { a.button:hover, a.button:active { transform: none; } }
.copied { visibility: hidden; color: var(--text-3); font: 12px "IBM Plex Mono", ui-monospace, monospace; }
::-webkit-scrollbar { width: 14px; height: 14px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--line-strong); background-clip: padding-box;
  border: 2px solid var(--ink); border-radius: 6px; box-shadow: inset 0 0 0 2px var(--bg-code);
}
::-webkit-scrollbar-thumb:hover { background: var(--fill-accent); }
::-webkit-scrollbar-button, ::-webkit-scrollbar-corner { display: none; background: transparent; }
`;

/** The whole page, with the error text HTML-escaped. */
export function startupErrorPage(details: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BAKED failed to start</title>
<style>${STYLE}</style>
</head>
<body>
<span class="badge">Startup error</span>
<h1>BAKED failed to start</h1>
<p>The app hit an error before its window could load. Copy the details below when you report it.</p>
<pre>${escapeHtml(details)}</pre>
<div class="actions">
<a class="button primary" href="${ACTION_SCHEME}copy">Copy details</a>
<a class="button" href="${ACTION_SCHEME}quit">Quit</a>
<span class="copied" role="status">Copied</span>
</div>
</body>
</html>
`;
}

/** The page as a data URL, for `BrowserWindow.loadURL`. */
export function startupErrorUrl(details: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(startupErrorPage(details))}`;
}
