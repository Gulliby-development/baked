# Brand

BAKED has one logo and one mascot.

- **Logo: the oven.** An oven front with a shell prompt (`>_`) glowing in its door. It is the app icon, the installer icon, the tray icon and the mark in the desktop title bar. Code goes in, finished work comes out.
- **Mascot: the bun.** Inside the terminal UI, the bun is the character that talks to you and shows that work is in progress. The oven is what you click to open BAKED; the bun is who you work with inside it.

## Style

Everything follows the neobrutalist look of the desktop app: 2 px ink outlines, hard offset shadows without blur, square line ends, and only the BAKED palette (orange accent `#ff9d52`, warm dark `#191410`, cream `#fff4e5`). Every asset has a dark and a light version, or works on both.

## Files

| File | Use |
| --- | --- |
| `docs/assets/brand/app-icon.svg` | The oven tile: orange body, dark door, cream knobs, hard shadow. |
| `docs/assets/brand/wordmark-dark.svg`, `wordmark-light.svg` | Tile and `BAKED` letters for dark and light backgrounds; pick one with `<picture>`. |
| `docs/assets/video/baked-promo-v2.mp4`, `baked-promo-v2.jpg` | The 88-second promo video (720p) and its poster with a play button; the README opens with the poster linking to the video. |
| `apps/desktop/build/icon.svg` → `icon.png` | App icon, 1024 px. electron-builder derives the `.ico`, `.icns` and Linux icons from the PNG. |
| `apps/desktop/build/tray.svg` → `tray.png`, `tray@2x.png` | Tray icon on Windows and Linux, 16 and 32 px: orange oven with dark cut-outs. |
| `apps/desktop/build/trayTemplate.svg` → `trayTemplate.png`, `trayTemplate@2x.png` | macOS menu bar template: black with transparent cut-outs, recoloured by the system. |
| `apps/desktop/src/renderer/favicon.svg` | Window favicon. |
| `apps/desktop/src/renderer/components/BakedMark.tsx` | The oven as a one-colour glyph in the current text colour, used in the title bar. |

The PNGs are exports of their SVG at the listed sizes with a transparent background. When an SVG changes, export its PNGs again at the same sizes.

## Icons

`apps/desktop/src/renderer/components/Icon.tsx` holds the desktop line icons: one stroked path each on a 24 px grid, 2 px strokes with square ends, drawn in the current text colour. They follow the baking theme where a metaphor helps:

| Icon | Shows | Used for |
| --- | --- | --- |
| `overview` | oven | project overview |
| `chat` | speech bubble | chat |
| `runs` | tray of buns | workflow runs |
| `initiatives` | pennant | initiatives |
| `acceptance` | quality seal | acceptance |
| `usage` | measuring jug | usage |
| `gates` | oven thermometer | gates and checks |
| `instructions` | recipe card | instructions |
| `working-set` | mixing bowl | working set |
| `run-memory` | sourdough starter jar | run memory |
| `attention` | counter bell | items that need you |
| `projects` | tiles | all projects |
| `settings` | oven knob | settings |
| `new`, `undo`, `redo`, `send`, `stop`, `mic`, `eye`, `chevron-right`, `chevron-down` | controls | buttons and menus |
| `research`, `spec`, `plan`, `implement`, `checks`, `review`, `accept` | wheat ear, checked sheet, loaf in a tin, whisk, thermometer, tasting spoon, quality seal | workflow stages on the run conveyor and in the run list's Stage column |
| `ok`, `failed`, `waiting`, `warning`, `running` | ticked box, crossed box, hourglass, triangle, open ring | stage states on conveyor stations, run status pills, tool call results |
| `read`, `edit`, `shell`, `search`, `git`, `image` | open book, pencil, terminal, magnifier, branch, picture | chat tool calls, by tool |
| `fork`, `rewind`, `compact`, `model` | chat actions | Fork from here, fork and rewind reports, Compact now, the model picker and context panel |
| `database`, `shield`, `globe` | storage drum, shield, globe | Diagnostics: the Storage section, the Sandbox section and its mode, the sandboxed chat network; `database` also marks cache reads on Usage |
| `cost` | coin | Usage: the cost estimate |

`stageIcon` in `screens/runs/line-model.ts` picks a stage's icon from its role in the workflow line (a station of type `tasks` gets `implement`, one that makes `spec` gets `spec`, the finish station gets `accept`); stages it cannot place get `research`. `toolIcon` in `screens/chat/tools.ts` maps tool names, and tools without an icon of their own (MCP tools, for example) show `model`.

New icons use the same grid, stroke and line ends. Larger places (empty states, 24 px and up) use the block style through `BlockIcon`: the same shape filled with `--fill-accent`, an `--ink` outline and a 1.5 px hard ink shadow. The empty states for no projects, no runs and a new chat show `projects`, `runs` and `chat` at 40 px.

On Windows the taskbar button carries an overlay icon with the number of items that need you, since `app.setBadgeCount` shows nothing there (`apps/desktop/src/main/tray.ts`).
