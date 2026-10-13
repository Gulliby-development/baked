# BAKED documentation

This folder describes BAKED as it works now. It is the only place for long-lived documentation: user guides, references, architecture and the design of features that shipped. Plans and one-off reports do not belong here.

## Use BAKED

- [Getting started](getting-started.md): install, first run, essential shortcuts.
- [User guide](guide.md): the terminal UI, models and the task router, modes, plan mode, checkpoints, sessions, tabs, Git, context, memory and projects.
- [Commands and keys](commands.md): every slash command and keyboard shortcut.
- [Headless CLI](headless.md): `baked --headless` for scripts and CI.
- [Configuration](configuration.md): config files, settings, key storage, instruction files and environment variables.
- [Providers](providers.md): Claude, OpenAI, Codex, GitHub Copilot and GitHub Models, and model fallback.
- [Tools and code intelligence](tools.md): what the agent can do and how it reads code.
- [OS sandbox](sandbox.md): shell, check and acceptance commands in bubblewrap or seatbelt, credentials hidden.
- [Extensions](extensions.md): MCP servers, hooks and skills.
- [Custom commands](custom-commands.md): Markdown files that become slash commands.
- [Watch mode](watch.md): `baked!` and `baked?` comments written in any editor start the agent.
- [Artifacts](artifacts.md): HTML pages shared by every project and chat, deployed to your own Vercel account.
- [Projects](projects.md): the project manifest, working set and known-projects list.
- [Project coordinator](coordinator.md): one long-lived chat per project with a durable project brief.
- [Privacy and telemetry](privacy.md): what is stored, what is sent, how to opt out.
- [Troubleshooting](troubleshooting.md).

## Spec-driven workflows

- [Workflows](workflows/README.md): what `baked workflow` does and where each part is documented.

## Desktop app

- [Desktop app](desktop/app.md): the Electron app in `apps/desktop`, one `baked serve` per project.
- [Desktop API](desktop/api.md): the contract between the desktop app and `baked serve`.

## Internals

- [Architecture](architecture.md): how the agent, the repository graph, tools and storage fit together.
- [Bench loop](bench-loop.md): the agent loop that builds apps with BAKED, files what it finds and publishes the apps that pass.
- [Feature parity](parity.md): the feature registry, the parity test and which surface lacks what.
- [Brand](brand.md): the oven logo, the bun mascot and the icon set.
- [CONTRIBUTING.md](../CONTRIBUTING.md): development setup, checks, distributables and releases.

## Keeping this folder current

A change that adds or alters a user-visible feature, a command, a setting, the local API or a workflow updates the matching page here in the same branch (see [AGENTS.md](../AGENTS.md)). Pages describe current behavior; Git history keeps the earlier designs. `tests/docs.test.ts` checks that every relative link and every `docs/` path named in source comments resolves.
