# Artifacts

An artifact is a self-contained HTML page (styles and scripts inline) that BAKED keeps for your user, not for a project. Every project and every chat sees the same artifacts, and any of them can publish one to your own Vercel account.

## Where they live

Artifacts are stored in the BAKED data folder: `~/.baked/artifacts/` on macOS and Linux, `%LOCALAPPDATA%\baked\artifacts\` on Windows. Each artifact is a folder named by its ID with `meta.json` (title, description, version, the project it was last saved from, its deploys) and one `vN.html` per version. Saving again under the same ID adds a version; older versions stay readable. The ID comes from the page's title (`Sales chart` is `sales-chart`, then `sales-chart-2`), lowercase letters, digits and hyphens. A page holds at most 5 MiB. Nothing in a repository changes, so artifacts never end up in a commit.

## From any chat

The agent's `artifact` tool saves a page it wrote (as HTML, or from an `.html` file of the project), lists and reads artifacts, and deploys one. Ask in words: "save this page as an artifact", "deploy the release-notes artifact", "deploy it to production". A deploy shows what goes where and waits for your yes in every approval mode, auto included; a chat that cannot ask (a headless run) refuses to deploy. Subagents cannot deploy. In architect and plan mode, the coordinator included, the tool only lists and reads artifacts.

A page saved without styles of its own (no `<style>` block or stylesheet link) gets the [BAKED kit](kit.md): its stylesheet goes into the page's head and a small "Made with BAKED" line ends its body. The agent can pass `kit: false` to keep a page exactly as written; `designKit: "off"` turns this off. `baked artifacts save` stores a file as it is.

## Terminal and desktop

`/artifacts` lists the artifacts; picking one opens it in the browser. `/artifacts deploy ID` (or `ID prod`) asks the agent to deploy it, with the same confirmation. In the desktop app, Artifacts in every project's sidebar shows the list, a preview, Open in browser and Deploy preview… or Deploy to production…, which confirm in a dialog first; the local API is in [`desktop/api.md`](desktop/api.md#artifacts).

## Headless

```sh
baked artifacts list                       # every artifact, the most recently updated first
baked artifacts save chart.html            # a new artifact from a file (--id ID adds a version)
baked artifacts show sales-chart           # details and deploys; --html prints the page, --version N an older one
baked artifacts deploy sales-chart         # prints what would be sent; add --yes to deploy
baked artifacts deploy sales-chart --prod --yes
baked artifacts remove sales-chart
```

`list`, `show`, `save` and `deploy` take `--json`. `deploy` exits 1 when it is refused (deploys off, no token, a secret in the page) or without `--yes`, and 2 for an unknown artifact or bad arguments.

## Deploying to Vercel

A deploy publishes the artifact's latest version to your own Vercel account through the Vercel REST API, with no build step: the page is sent as `index.html` of the Vercel project `baked-<id>`, created on the first deploy. BAKED has no account of its own and keeps no copy anywhere else.

- **Off by default.** Turn on `artifactDeploy` (Settings > Tools > Artifacts, or `"artifactDeploy": true` in the user config).
- **Your token.** Create a token in Vercel > Account Settings > Tokens, best limited to one team and with an expiry, and save it as the Vercel token in Settings > Tools > Artifacts (stored like provider keys) or set `VERCEL_TOKEN`. `vercelTeamId` in the user config or `VERCEL_TEAM_ID` deploys to a team instead of the personal account.
- **Preview by default.** A preview deployment is behind Vercel Authentication, so only your Vercel team can open it, unless you turned that protection off. `--prod` makes a production deployment, which anyone with the link can open.
- **Asks every time.** A deploy sends the page off your machine, so it always needs your confirmation: the chat's approval, the desktop dialog, or `--yes` headless.
- **Secret scan.** Before anything is sent the page is scanned for known key formats (Anthropic, OpenAI, GitHub, AWS, Google, Slack and Vercel keys, private keys), credential assignments such as `api_key: "..."` and the values of secret environment variables of the process. A finding refuses the deploy and names the line, never the value.

Each deploy is recorded on the artifact with the version it published, the target and the URL. Vercel's Hobby plan allows 100 deployments a day and non-commercial use only; teams use Pro.
