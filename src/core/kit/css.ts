/**
 * The BAKED kit: one self-contained stylesheet that gives web pages made in BAKED the BAKED look
 * (neobrutalist outlines and hard shadows in the BAKED palette) when their project has no styling
 * of its own. The colours are the desktop app's (`apps/desktop/src/renderer/styles/tokens.css`);
 * `tests/kit.test.ts` keeps them in step.
 */

export const KIT_VERSION = 1;
export const KIT_FILE = "baked-kit.css";

/** Kit variable → [light, dark] value. */
export const KIT_PALETTE = {
  bg: ["#fffaf2", "#191410"],
  surface: ["#fff3e2", "#201913"],
  sunken: ["#f6e6d1", "#1d1712"],
  line: ["#e2c9ad", "#3a2c21"],
  edge: ["#302015", "#68513f"],
  ink: ["#302015", "#000000"],
  text: ["#302015", "#fff4e5"],
  "text-2": ["#57402d", "#e5d4c1"],
  muted: ["#71563f", "#c2ac96"],
  accent: ["#a7440b", "#ff9d52"],
  "accent-fill": ["#ff9d52", "#ff9d52"],
  "on-fill": ["#302015", "#191410"],
  code: ["#f1e3d0", "#100c09"],
  ok: ["#426b2f", "#accd94"],
  warn: ["#815007", "#f2c575"],
  err: ["#b02e25", "#ff8e86"],
  "fill-ok": ["#b9dca0", "#accd94"],
  "fill-warn": ["#f7d38a", "#f2c575"],
  "fill-err": ["#ffa69f", "#ff8e86"],
} as const satisfies Record<string, readonly [string, string]>;

/** The layout and component classes, for the agent's guidance and the artifact tool. */
export const KIT_CLASSES =
  "bk-container, bk-stack, bk-row, bk-grid, bk-hero, bk-nav, bk-card, bk-btn, bk-btn-ghost, bk-badge (bk-badge-ok, -warn, -err), bk-callout (bk-callout-ok, -warn, -err), bk-muted";

const vars = (side: 0 | 1) =>
  Object.entries(KIT_PALETTE)
    .map(([name, values]) => `--bk-${name}:${values[side]}`)
    .join(";");

const BODY = `*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bk-bg);color:var(--bk-text);font:16px/1.6 var(--bk-font);-webkit-font-smoothing:antialiased}
h1,h2,h3,h4{line-height:1.15;margin:1.6em 0 .6em;font-weight:700;letter-spacing:-.01em}
h1{font-size:clamp(2rem,5vw,3rem)}h2{font-size:1.7rem}h3{font-size:1.3rem}h4{font-size:1.1rem}
p,ul,ol,dl,blockquote,table,pre{margin:0 0 1rem}
a{color:var(--bk-accent);text-decoration-thickness:2px;text-underline-offset:3px}
a:hover{text-decoration-thickness:3px}
code,kbd,pre{font-family:var(--bk-mono);font-size:.9em}
code,kbd{background:var(--bk-code);padding:.1em .35em;border-radius:4px}
pre{background:var(--bk-code);border:var(--bk-border);border-radius:var(--bk-radius);padding:1rem;overflow:auto}
pre code{background:none;padding:0}
blockquote{border-left:4px solid var(--bk-accent-fill);padding:.2rem 0 .2rem 1rem;color:var(--bk-text-2)}
hr{border:0;border-top:var(--bk-border);margin:2rem 0}
img,svg,video,canvas{max-width:100%;height:auto}
table{width:100%;border-collapse:collapse;border:var(--bk-border)}
th,td{padding:.55rem .8rem;border-bottom:1px solid var(--bk-line);text-align:left;vertical-align:top}
th{background:var(--bk-sunken);font-weight:600}
button,input,select,textarea{font:inherit;color:inherit}
input:not([type=checkbox]):not([type=radio]),select,textarea{width:100%;background:var(--bk-bg);border:var(--bk-border);border-radius:var(--bk-radius);padding:.5rem .7rem}
input[type=checkbox],input[type=radio]{accent-color:var(--bk-accent-fill);width:1.1rem;height:1.1rem}
label{display:block;font-weight:600;margin:0 0 .3rem}
:focus-visible{outline:3px solid var(--bk-accent-fill);outline-offset:2px}
::selection{background:var(--bk-accent-fill);color:var(--bk-on-fill)}
button,.bk-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;padding:.55rem 1.1rem;background:var(--bk-accent-fill);color:var(--bk-on-fill);border:2px solid var(--bk-ink);border-radius:var(--bk-radius);box-shadow:var(--bk-shadow-sm);font-weight:600;line-height:1.2;text-decoration:none;cursor:pointer;transition:transform .12s ease,box-shadow .12s ease}
button:hover,.bk-btn:hover{transform:translate(-1px,-1px);box-shadow:3px 3px 0 0 var(--bk-ink)}
button:active,.bk-btn:active{transform:translate(2px,2px);box-shadow:none}
button:disabled,.bk-btn[aria-disabled=true]{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}
.bk-btn-ghost{background:var(--bk-surface);color:var(--bk-text);border-color:var(--bk-edge)}
.bk-container{max-width:72rem;margin:0 auto;padding:0 1.25rem}
.bk-stack>*+*{margin-top:1rem}
.bk-row{display:flex;flex-wrap:wrap;gap:1rem;align-items:center}
.bk-grid{display:grid;gap:1.25rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}
.bk-hero{padding:4rem 0 3rem}
.bk-hero h1{margin-top:0}
.bk-nav{display:flex;flex-wrap:wrap;gap:1.25rem;align-items:center;padding:1rem 0;border-bottom:var(--bk-border)}
.bk-nav a{color:var(--bk-text);font-weight:600;text-decoration:none}
.bk-nav a:hover,.bk-nav a[aria-current]{color:var(--bk-accent)}
.bk-card{background:var(--bk-surface);border:var(--bk-border);border-radius:var(--bk-radius);box-shadow:var(--bk-shadow);padding:1.25rem}
.bk-card>:first-child{margin-top:0}.bk-card>:last-child{margin-bottom:0}
.bk-badge{display:inline-block;padding:.05rem .55rem;border:2px solid var(--bk-ink);border-radius:999px;font-size:.8rem;font-weight:600;background:var(--bk-sunken);color:var(--bk-text)}
.bk-badge-ok{background:var(--bk-fill-ok);color:var(--bk-on-fill)}
.bk-badge-warn{background:var(--bk-fill-warn);color:var(--bk-on-fill)}
.bk-badge-err{background:var(--bk-fill-err);color:var(--bk-on-fill)}
.bk-callout{background:var(--bk-surface);border:var(--bk-border);border-left:6px solid var(--bk-accent-fill);border-radius:var(--bk-radius);padding:.9rem 1.1rem;margin:0 0 1rem}
.bk-callout-ok{border-left-color:var(--bk-ok)}.bk-callout-warn{border-left-color:var(--bk-warn)}.bk-callout-err{border-left-color:var(--bk-err)}
.bk-muted{color:var(--bk-muted)}
.bk-made{display:block;margin:3rem auto 1.5rem;text-align:center;font-size:.8rem;color:var(--bk-muted)}
.bk-made b{color:var(--bk-accent)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}`;

/** The kit stylesheet: light by default, dark by the system or `data-theme="dark"` on the root. */
export const KIT_CSS = `/* BAKED kit v${KIT_VERSION}. Change the --bk-* variables in your own CSS to rebrand. */
:root{color-scheme:light dark;${vars(0)};--bk-font:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--bk-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--bk-radius:6px;--bk-border:2px solid var(--bk-edge);--bk-shadow:4px 4px 0 0 var(--bk-ink);--bk-shadow-sm:2px 2px 0 0 var(--bk-ink)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(1)}}}
:root[data-theme=dark]{${vars(1)}}
${BODY}
`;

/** The footer mark artifacts carry; project pages only get the generator meta tag. */
export const KIT_MADE_WITH = '<footer class="bk-made">Made with <b>BAKED</b></footer>';
export const KIT_GENERATOR_META = '<meta name="generator" content="BAKED">';
