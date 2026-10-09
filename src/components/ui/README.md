# Baked terminal interface

The application uses React 19 and OpenTUI. `PremiumPopup` is the shared shell for modal screens, settings and dialogs.

## Design

Baked Dark is the default: warm toasted surfaces, cream text and orange focus. Baked Light uses flour-white surfaces, brown text and toasted orange accents. Only these two palettes are selectable. Use semantic tokens from `useTheme()`; do not hardcode component colors.

- The header identifies the screen and active section; descriptions occupy their own line.
- At widths below 88 cells, sidebar navigation becomes a horizontal strip. The active tab scrolls into view. Mouse selection uses the same state setters as keyboard selection and respects pending operations.
- Popup dimensions are bounded by the terminal. Preferred sizes are not minimum sizes. Use `fitPopupWidth`, `fitPopupHeight` and `popupContentWidth` when calculating child layouts.
- The footer remains outside the scrolling body. Shortcut groups wrap to available width. `Shift+PageUp/PageDown` scrolls the body; the hint appears when content overflows. Wheel scrolling is also available.
- Focus uses a marker, bold text and a contrasting surface. It is not communicated by color alone. Selected, disabled, loading, empty and error states remain distinct.
- Search preserves the result count and the end of a long query. Model search includes display names and technical model IDs.
- Long item descriptions are constrained independently from names. `GroupedList`, `Table` and `VirtualList` keep selection visible, including rows taller than one cell.
- `FocusTarget` brings focused form controls into the popup viewport. Use it for custom forms with keyboard traversal.

## Screen inventory and audit

The inventory follows every `ModalName` in `src/stores/ui.ts`, plus shared dialogs and the main workspace. Shared-shell changes apply to every listed modal, including secondary states rendered by the same component.

| Screen / component | States reviewed | UI treatment |
| --- | --- | --- |
| LandingPage, InputBox, Footer | Empty workspace, conversation, status | Shared Baked palette; bread animation retained |
| TabBar, TabNamePopup | Five sessions, activity, new tab | Responsive tab widths, mouse switching, clear active rail, shared naming dialog |
| CommandPalette | Categories, filtering, no results | Search-first layout, separated names/descriptions; selection resets after query edits |
| CommandPicker | Commands, theme/settings choices, scope, toggles | Bounded shell, scrollable content, wrapped action hints |
| LlmSelector | Providers, models, availability, search | Consistent search; names and IDs searchable; selected rows stay visible |
| ProviderSettings | Claude, OpenAI, GitHub, general | Responsive navigation; shorter label columns and reduced option previews at narrow widths |
| RouterSettings | Task routes, fallback chains, scope | Bounded settings panel and consistent controls |
| SkillSearch | Search, installed, active, install destination, loading/error | Shared search; destination replaces results; explicit catalog errors; stale search responses ignored |
| ApiKeySettings | Provider list, secret entry, removal | Common shell, search/selection and action footer; secret handling preserved |
| WebSearchSettings | Key list and key entry | Common shell and readable form states |
| ToolsPopup | Enabled/disabled tools | Shared list viewport and selection |
| SetupGuide | Runtime tools | Adaptive tab navigation and common action footer |
| LspStatusPopup | Servers and details | Bounded shell and scrollable content |
| LspInstallSearch | Search, installed packages, enable/disable scope | Adaptive navigation and shared list behavior; pending-operation guard |
| RepoMapStatusPopup | Index status, mode, budget, regeneration | Shared controls, shell, colors and scrolling |
| StatusDashboard | Usage, context, system, tabs | Responsive navigation and shared data primitives |
| ModelEventsPopup | Event categories/details | Adaptive navigation, bounded panel |
| MemoryBrowser | Memories, search, cleanup, settings, purge confirmation | Adaptive navigation; settings/confirmation guard retained |
| SessionPicker | Saved sessions, search, restore/delete | Shared search/list, bounded dimensions |
| GitMenu, GitCommitModal | Actions, changes, commit message | Shared shell and action styling |
| HelpPopup, InfoPopup, DiagnosePopup | Help, read-only information, diagnostics | Consistent headers, readable descriptions, bounded scroll areas |
| ErrorLog, CompactionLog, LogViewer | Event lists and detail views | Common LogViewer shell and semantic status colors |
| WorkflowPanel, WorkflowIndicator | Run list, disabled project, new-run form, run sections, approval/clarification/evidence/recovery decisions | Two-line list rows below 64 cells; state-dependent action hints; one-line status above the footer while closed |
| UpdateModal | Checking, current, available, upgrading, failure | Common shell for every branch; version comes from package.json |
| FirstRunWizard | All 11 onboarding steps, setup and theme choices | Adaptive step navigation, numbered progress, shared palette, scrollable body |
| AlertDialog, ConfirmDialog, DialogSelect | Notice, destructive confirmation, searchable selection | Common shell; confirmation footer accurately describes Enter as choosing the current selection |
| QuestionPrompt, PlanReviewPrompt, approval prompts | Choices, text entry, approvals | Inherit the Baked semantic palette and shared keyboard hints; authorization behavior unchanged |

## Component contract

```tsx
<PremiumPopup
  visible={open}
  width={100}
  height={30}
  title="Settings"
  tabs={tabs}
  activeTab={tab}
  onTabChange={setTab}
  footerHints={[
    { key: "Tab", label: "section" },
    { key: "Enter", label: "select" },
    { key: "Esc", label: "close" },
  ]}
>
  <Section title="Behavior">
    <Toggle label="Auto-compact" on={enabled} focused={focused} />
  </Section>
</PremiumPopup>
```

The caller owns keyboard routing, selected state, validation and persistence. Controls do not save settings implicitly. `onTabChange` must preserve the same guards as keyboard navigation, particularly while an install, confirmation or form is pending. Add `onChange` to a segmented control only when the caller can apply that change.

`useScrollLayout` preserves OpenTUI's internal size callbacks before handling selection or overflow. Replacing `contentOptions.onSizeChange` directly would disable recalculation of scroll bounds in OpenTUI 0.4.2.

## Verification

```sh
bun test tests/ui-modernization.test.tsx
bun run typecheck
bun run build
```

Renderer tests cover 120×40, 80×24 and 50×20 terminals, borders/exit hints, command execution after filtering, tab creation, mouse navigation, long search input and multi-line list scrolling. A separate-process fixture exercises real model, skill, provider, router, MCP, help, information, demo and onboarding components; catalog services are mocked to avoid network calls or installations. It captures more than 100 screen states. This verifies rendering and navigation, not live provider authentication, installation or daemon operation.

For local inspection, set `BAKED_UI_CAPTURE_DIR` to an ignored output directory and run `bun tests/fixtures/ui-catalog-screens.tsx`. Do not commit generated frames or captures of real credentials/session data.

## Technology choices

The modernization retains the installed OpenTUI/React stack. OpenTUI already supplies scrollable renderables, mouse events and deterministic terminal testing; another UI framework would add migration cost without addressing layout and focus defects. Sources: [OpenTUI interaction](https://opentui.com/docs/core-concepts/interaction/), [OpenTUI testing](https://opentui.com/docs/core-concepts/testing/), [OpenTUI scrollbox](https://opentui.com/docs/components/scrollbox/). The use of readable text labels alongside colors follows the CLI accessibility approach described in [GitHub's accessibility work](https://github.blog/engineering/user-experience/building-a-more-accessible-github-cli/).
