import { useEffect, useState } from "react";
import { bridge } from "../../client/bridge.js";
import {
  type CliLogin,
  type CliSignIn,
  type ConfigView,
  type ProviderStatus,
  setup,
} from "../../client/setup.js";
import { Button } from "../../components/ui/button.js";
import { useDesktop } from "../../store.js";
import { commandLabel, signInView } from "./logic.js";
import { type RoutingProject, RoutingSection } from "./RoutingSection.js";
import { errorText, LoadState, NeedsNewer, Tag, useLoad } from "./shared.js";

/** Writes top-level keys of the global config; resolves to whether it worked. */
type Patch = (set: Record<string, unknown>) => Promise<boolean>;

const LOGIN_POLL_MS = 1000;
const LOGIN_LINES_SHOWN = 8;

/**
 * Sign-in for a provider that runs through its own CLI: the backend starts the CLI's login, which
 * opens the browser; this polls its progress and offers the sign-in page in case none opened.
 */
function CliSignInControls({
  projectKey,
  provider,
  signIn,
  onChanged,
}: {
  projectKey: string;
  provider: ProviderStatus;
  signIn: CliSignIn;
  onChanged: () => void;
}) {
  const [login, setLogin] = useState<CliLogin | null>(signIn.login);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = login?.state === "running";

  useEffect(() => {
    if (!running) return;
    let live = true;
    const timer = setInterval(() => {
      setup.login(projectKey, provider.id).then(
        ({ login: next }) => {
          if (!live) return;
          setLogin(next);
          if (next?.state !== "running") onChanged();
        },
        (e: unknown) => live && setError(errorText(e)),
      );
    }, LOGIN_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running, projectKey, provider.id, onChanged]);

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const view = signInView({ ...signIn, login });
  const shown = login?.lines.slice(-LOGIN_LINES_SHOWN) ?? [];

  return (
    <>
      {view.action === "sign-in" && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const started = (await setup.startLogin(projectKey, provider.id)).login;
              setLogin(started);
              onChanged();
            })
          }
        >
          Sign in
        </Button>
      )}
      {view.action === "cancel" && login?.url && (
        <Button
          size="sm"
          variant="neutral"
          onClick={() => void bridge.openExternal(login.url ?? "")}
        >
          Open sign-in page
        </Button>
      )}
      {view.action === "cancel" && (
        <Button
          size="sm"
          variant="neutral"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setLogin((await setup.cancelLogin(projectKey, provider.id)).login);
              onChanged();
            })
          }
        >
          Cancel
        </Button>
      )}
      {view.action === "sign-out" && (
        <Button
          size="sm"
          variant="neutral"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const result = await setup.logout(projectKey, provider.id);
              if (!result.ok) throw new Error(result.message);
              setLogin(null);
              onChanged();
            })
          }
        >
          Sign out
        </Button>
      )}
      {view.action === "install" && (
        <span className="muted setup-note setup-full">
          Install the {provider.name} CLI, then sign in here or run{" "}
          <code className="mono">{signIn.command}</code> in a terminal.
        </span>
      )}
      {running && shown.length > 0 && (
        <pre className="setup-login-log mono setup-full" aria-live="polite">
          {shown.join("\n")}
        </pre>
      )}
      {login?.state === "failed" && (
        <div className="banner error setup-full">
          {login.error ?? "Sign-in failed."} You can also run{" "}
          <code className="mono">{signIn.command}</code> in a terminal.
        </div>
      )}
      {error && <div className="banner error setup-full">{error}</div>}
    </>
  );
}

function ProviderRow({
  projectKey,
  provider,
  onChanged,
}: {
  projectKey: string;
  provider: ProviderStatus;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setEditing(false);
      setValue("");
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const inputId = `key-${provider.id}`;
  return (
    <li className="setup-line setup-wrap-line">
      <span className={`dot ${provider.configured ? "ok" : ""}`} aria-hidden="true" />
      <span className="setup-grow stack">
        <span>{provider.name}</span>
        <span className="muted setup-note">
          {provider.signIn
            ? signInView(provider.signIn).note
            : provider.configured
              ? provider.source === "env"
                ? "configured · key from an environment variable"
                : provider.source === "app"
                  ? "configured · key saved by BAKED"
                  : "configured"
              : "not configured"}
          {!provider.acceptsKey && !provider.signIn && " · signs in without an API key"}
        </span>
      </span>
      {provider.signIn && (
        <CliSignInControls
          projectKey={projectKey}
          provider={provider}
          signIn={provider.signIn}
          onChanged={onChanged}
        />
      )}
      {provider.keyUrl && !provider.configured && (
        <a href={provider.keyUrl} target="_blank" rel="noreferrer">
          Get a key
        </a>
      )}
      {provider.acceptsKey && !editing && (
        <button type="button" className="btn" onClick={() => setEditing(true)}>
          {provider.source === "app" ? "Replace key" : "Set key"}
        </button>
      )}
      {provider.acceptsKey && provider.source === "app" && !editing && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void run(() => setup.removeProviderKey(projectKey, provider.id))}
        >
          Remove key
        </button>
      )}
      {editing && (
        <form
          className="setup-add setup-full"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim())
              void run(() => setup.setProviderKey(projectKey, provider.id, value.trim()));
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {provider.name} API key
          </label>
          <input
            id={inputId}
            type="password"
            className="mono"
            autoComplete="off"
            placeholder="Paste the API key"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit" className="btn-primary" disabled={busy || !value.trim()}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && <div className="banner error setup-full">{error}</div>}
    </li>
  );
}

function Providers({ projectKey }: { projectKey: string }) {
  const [providers, reload] = useLoad(() => setup.providers(projectKey), [projectKey]);
  return (
    <section className="setup-section" aria-labelledby="providers">
      <h2 id="providers" className="setup-h2">
        Providers and keys
      </h2>
      <p className="lede">
        Keys live in the system keychain or the environment, never in config files, and are never
        shown here.
      </p>
      {providers.state === "ready" ? (
        <ul className="card setup-list setup-flush">
          {providers.data.providers.map((p) => (
            <ProviderRow key={p.id} projectKey={projectKey} provider={p} onChanged={reload} />
          ))}
        </ul>
      ) : (
        <LoadState value={providers} what="providers" />
      )}
    </section>
  );
}

function GlobalCommands({ projectKey }: { projectKey: string }) {
  const [commands] = useLoad(() => setup.commands(projectKey), [projectKey]);
  const global =
    commands.state === "ready" ? commands.data.commands.filter((c) => c.scope === "global") : [];
  return (
    <section className="setup-section" aria-labelledby="commands">
      <h2 id="commands" className="setup-h2">
        Global commands
      </h2>
      <p className="lede">
        Markdown prompt templates in <span className="mono">~/.baked/commands/</span>, offered as
        slash commands in every project: <span className="mono">fix-ci.md</span> becomes{" "}
        <span className="mono">/fix-ci</span>.
      </p>
      {commands.state !== "ready" ? (
        <LoadState value={commands} what="the command list" />
      ) : global.length === 0 ? (
        <div className="empty">No global commands.</div>
      ) : (
        <ul className="card setup-list setup-flush">
          {global.map((c) => (
            <li key={c.path} className="setup-line">
              <span className="mono">
                {commandLabel(c.name)}
                {c.argumentHint ? <span className="muted"> {c.argumentHint}</span> : null}
              </span>
              <span className="muted setup-grow">{c.description}</span>
              <span className="mono muted setup-note">{c.path}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Telemetry({ config, patch, busy }: { config: ConfigView; patch: Patch; busy: boolean }) {
  const enabled = config.global.telemetry !== false;
  const url = config.effective.telemetryUrl;
  return (
    <section className="setup-section" aria-labelledby="telemetry">
      <h2 id="telemetry" className="setup-h2">
        Telemetry
      </h2>
      <div className="card setup-stack">
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void patch({ telemetry: e.target.checked })}
          />
          Record anonymous usage stats (version, OS, surface)
        </label>
        <span className="muted setup-note">
          {!enabled
            ? "Nothing is recorded."
            : url
              ? `Recorded in the local log and also sent to ${url} (telemetryUrl).`
              : "Recorded only in a local log under ~/.baked/telemetry; nothing is sent. Run baked telemetry to see it."}{" "}
          Prompts, paths and keys are never recorded. DO_NOT_TRACK=1 turns it off too.
        </span>
      </div>
    </section>
  );
}

interface NotificationsConfig {
  system?: boolean;
  webhook?: { url?: string; headers?: Record<string, string>; blockingOnly?: boolean };
}

/** `notifications` of the global config: terminal notifications and the run attention webhook. */
function Notifications({
  config,
  patch,
  busy,
}: {
  config: ConfigView;
  patch: Patch;
  busy: boolean;
}) {
  const current = (config.global.notifications ?? {}) as NotificationsConfig;
  const url = current.webhook?.url ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? url;
  const valid = /^https?:\/\/\S+$/i.test(value.trim());
  const save = (next: NotificationsConfig): Promise<boolean> => patch({ notifications: next });
  return (
    <section className="setup-section" aria-labelledby="notifications">
      <h2 id="notifications" className="setup-h2">
        Run notifications
      </h2>
      <div className="card setup-stack">
        <span className="muted setup-note">
          When a run waits for an approval, an answer or a budget extension. This app's own
          notifications are in the tray menu.
        </span>
        <label className="check">
          <input
            type="checkbox"
            checked={current.system !== false}
            disabled={busy}
            onChange={(e) => void save({ ...current, system: e.target.checked })}
          />
          Desktop notifications from the terminal app and the CLI
        </label>
        <form
          className="setup-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid)
              void save({ ...current, webhook: { ...current.webhook, url: value.trim() } }).then(
                (ok) => ok && setDraft(null),
              );
          }}
        >
          <label htmlFor="notifications-webhook" className="sr-only">
            Webhook URL
          </label>
          <input
            id="notifications-webhook"
            type="text"
            className="mono"
            autoComplete="off"
            placeholder="https://example.com/hook"
            value={value}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || !valid || value.trim() === url}
          >
            Save
          </button>
          {url && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                const { webhook: _removed, ...rest } = current;
                void save(rest).then((ok) => ok && setDraft(null));
              }}
            >
              Remove
            </button>
          )}
        </form>
        {url && (
          <label className="check">
            <input
              type="checkbox"
              checked={current.webhook?.blockingOnly === true}
              disabled={busy}
              onChange={(e) =>
                void save({
                  ...current,
                  webhook: { ...current.webhook, blockingOnly: e.target.checked },
                })
              }
            />
            Only requests the run waits for (skip advisory acceptance decisions)
          </label>
        )}
        <span className="muted setup-note">
          {url
            ? `Each waiting run is posted once to ${url} as JSON: run, feature, request kind, never its content.`
            : "No webhook: nothing is sent."}{" "}
          Headers such as a token go in notifications.webhook.headers of the config file.
        </span>
      </div>
    </section>
  );
}

/** In-page targets; buttons rather than `#id` links, which the hash router would take. */
const TOC = [
  ["providers", "Providers and keys"],
  ["routing", "Model routing"],
  ["commands", "Global commands"],
  ["notifications", "Run notifications"],
  ["telemetry", "Telemetry"],
] as const;

export function GlobalSettings() {
  const { projects } = useDesktop();
  const host = projects.find((p) => p.backend.kind === "running");
  if (!host)
    return (
      <>
        <h1>All projects</h1>
        <div className="empty">
          Open a project to see these settings: any project's backend reads them from{" "}
          <span className="mono">~/.baked/config.json</span>.
        </div>
      </>
    );
  const running = projects
    .filter((p) => p.backend.kind === "running")
    .map((p) => ({ key: p.key, name: p.name }));
  return <GlobalSettingsFor projectKey={host.key} projectName={host.name} projects={running} />;
}

function GlobalSettingsFor({
  projectKey,
  projectName,
  projects,
}: {
  projectKey: string;
  projectName: string;
  /** Running projects; model routing resolves through the one picked there. */
  projects: RoutingProject[];
}) {
  const [config, , setConfig] = useLoad(() => setup.config(projectKey), [projectKey]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch: Patch = async (set) => {
    setBusy(true);
    setError(null);
    try {
      setConfig(await setup.patchConfig(projectKey, "global", { set }));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setup">
      <div className="stack" style={{ gap: 4 }}>
        <h1>All projects</h1>
        <span className="lede">
          Shared by every project on this computer, in{" "}
          <span className="mono">
            {config.state === "ready" ? config.data.paths.global : "~/.baked/config.json"}
          </span>
          . <Tag>read through {projectName}</Tag>
        </span>
      </div>
      <nav className="setup-toc" aria-label="On this page">
        {TOC.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="setup-toc-link"
            onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && <div className="banner error">{error}</div>}
      <Providers projectKey={projectKey} />
      {config.state === "ready" ? (
        <>
          <RoutingSection projects={projects} />
          <GlobalCommands projectKey={projectKey} />
          <Notifications config={config.data} patch={patch} busy={busy} />
          <Telemetry config={config.data} patch={patch} busy={busy} />
        </>
      ) : config.state === "missing" ? (
        <>
          <NeedsNewer what="notifications or telemetry" />
          <RoutingSection projects={projects} />
          <GlobalCommands projectKey={projectKey} />
        </>
      ) : (
        <LoadState value={config} what="the global config" />
      )}
    </div>
  );
}
