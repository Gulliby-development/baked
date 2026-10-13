# BAKED kit

The BAKED kit is a small stylesheet in the BAKED look: the palette of the desktop app, 2 px outlines, hard offset shadows without blur, light and dark themes. When a project has no styling of its own, the agent uses it for the web pages and UI it builds, so they come out styled and recognisably made with BAKED instead of plain browser defaults.

## When the agent uses it

BAKED decides from the project's files, once per chat (and once per workflow run, frozen with its instructions). The model never decides whether the kit applies.

| Project | What the agent is told |
| --- | --- |
| Empty, or web files (`.html`, `.jsx`, `.tsx`, `.vue`, `.svelte`, `.astro`, templates) with no styles | Use the kit for web UI; the stylesheet is included in its context |
| Has `baked-kit.css` and no other stylesheet | Keep new UI consistent with the kit; the stylesheet is not repeated |
| Has styles of its own | Nothing |
| Code with no web front end | Nothing |

A project counts as having styles of its own when any of these holds:

- an instruction file (`AGENTS.md`, `CLAUDE.md`, `baked.md`, the project manifest's files, `baked/constitution.md` for workflows) mentions CSS, Tailwind, styles, a theme, a design system or tokens, branding, a colour palette, typography or fonts;
- `package.json` depends on a CSS framework, component kit or CSS-in-JS library (Tailwind, UnoCSS, Bootstrap, Bulma, daisyUI, MUI, Chakra, Mantine, Ant Design, Radix Themes, HeroUI, PrimeReact, Vuetify, Element Plus, Quasar, Pico, styled-components, Emotion, vanilla-extract, Panda, Stitches, Sass, Less, Stylus);
- the project root has `tailwind.config.*`, `uno.config.*`, `postcss.config.*`, `panda.config.*` or shadcn's `components.json`;
- the project has a stylesheet (`.css`, `.scss`, `.sass`, `.less`, `.styl`, `.pcss`) other than `baked-kit.css`;
- an `.html`, `.vue`, `.svelte` or `.astro` file has a `<style>` block, a stylesheet link or the Tailwind CDN.

`node_modules`, build output (`dist`, `build`, `out`, `.next` and the like), `vendor`, `.baked`, `baked` and dot folders are not looked at; the scan stops five folders deep.

What you ask for always comes first: when you ask for another look, a CSS framework or your own brand, the agent leaves the kit out.

## What the agent does with it

It saves the stylesheet as `baked-kit.css` where the pages can load it, links it before any other CSS, and keeps it unchanged; CSS of the project's own goes in a separate file. Pages carry `<meta name="generator" content="BAKED">` in their head and no visible BAKED branding unless you ask.

The kit styles plain HTML elements (headings, links, buttons, forms, tables, code, quotes) and adds a few classes:

| Class | Use |
| --- | --- |
| `bk-container` | Centered page column, 72 rem wide |
| `bk-stack`, `bk-row`, `bk-grid` | Vertical spacing, a wrapping row, a responsive card grid |
| `bk-hero`, `bk-nav` | Page header block, navigation bar |
| `bk-card` | Outlined panel with a hard shadow |
| `bk-btn`, `bk-btn-ghost` | Buttons and button-styled links (plain `<button>` is styled too) |
| `bk-badge`, `bk-badge-ok`, `bk-badge-warn`, `bk-badge-err` | Pills |
| `bk-callout`, `bk-callout-ok`, `bk-callout-warn`, `bk-callout-err` | Notes with a coloured edge |
| `bk-muted` | Secondary text |

Colours, fonts, radius and shadows are `--bk-*` variables. Override them in the project's own CSS to rebrand, for example `:root { --bk-accent-fill: #4f7cff; }`. Dark mode follows the system; `data-theme="light"` or `data-theme="dark"` on `<html>` forces one.

## Artifacts

[Artifacts](artifacts.md) saved from a chat without styles of their own get the kit inlined and end with a small "Made with BAKED" line. A page with its own `<style>` or stylesheet stays as written, and the agent can pass `kit: false` to skip the kit on any page.

## Turning it off

`designKit` in `config.json`, per project or global, or **BAKED kit** in `/agent-features` and on the desktop's Agent features settings page:

| Value | Effect |
| --- | --- |
| `auto` (default) | The kit for web projects with no styles, and for unstyled artifacts |
| `always` | The kit is the preferred look for new UI in every project; existing screens keep their style unless you ask |
| `off` | Never: no guidance, and artifacts are saved as written |

A change applies to new chats and new workflow runs.

## For contributors

The kit lives in `src/core/kit/`: `css.ts` (the stylesheet and palette), `detect.ts` (the project check), `guidance.ts` (the text the agent gets) and `artifact.ts` (inlining into artifact pages). The palette must match `apps/desktop/src/renderer/styles/tokens.css`; `tests/kit.test.ts` fails when they drift. The guidance names no provider and reads as a project instruction, so every provider gets the same text.
