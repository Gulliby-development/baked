import { type ReactNode, useEffect, useState } from "react";
import { bridge } from "../../client/bridge.js";
import {
  type CliLogin,
  type CliSignIn,
  type ConfigView,
  type ProviderStatus,
  setup,
} from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Dot } from "../../components/ui/dot.js";
import { Empty } from "../../components/ui/empty.js";
import { cn } from "../../lib/cn.js";
import { CHECK, STACK as COLUMN, LEDE, PANEL } from "../../lib/styles.js";
import type { SettingsSection } from "../../router.js";
import { useDesktop } from "../../store.js";
import { GlobalCommands } from "./GlobalCommands.js";
import { signInView } from "./logic.js";
import { type RoutingProject, RoutingSection } from "./RoutingSection.js";
import {
  ADD,
  errorText,
  FLUSH,
  GROW,
  LINE_LOOSE,
  LIST,
  LoadState,
  NeedsNewer,
  NOTE,
  SETUP,
  STACK,
  Tag,
  useLoad,
} from "./shared.js";

const KEY_INPUT =
  "min-h-[34px] rounded-base border-2 border-border bg-[var(--bg)] px-[10px] text-foreground [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit]";

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
  canSwitch,
  onChanged,
}: {
  projectKey: string;
  provider: ProviderStatus;
  signIn: CliSignIn;
  /** Whether the backend has `POST /v1/providers/ID/switch`. */
  canSwitch: boolean;
  onChanged: () => void;
}) {
  const [login, setLogin] = useState<CliLogin | null>(signIn.login);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
      {view.action === "sign-out" && canSwitch && (
        <Button size="sm" variant="neutral" disabled={busy} onClick={() => setConfirming(true)}>
          Switch account
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Switch ${provider.name} account`}
        confirmLabel="Sign out and sign in"
        busy={busy}
        error={confirming ? error : null}
        onClose={() => setConfirming(false)}
        onConfirm={() =>
          void act(async () => {
            const result = await setup.switchAccount(projectKey, provider.id);
            if (!result.ok) throw new Error(result.message);
            setLogin(result.login);
            setConfirming(false);
            onChanged();
          })
        }
      >
        Signs the current account out of the {provider.name} CLI, then opens the browser to sign in
        with another account. The CLI keeps one account at a time; until the new sign-in finishes,{" "}
        {provider.name} models cannot run.
      </ConfirmDialog>
      {view.action === "install" && (
        <span className={cn("text-dim-foreground", NOTE, "basis-full")}>
          Install the {provider.name} CLI, then sign in here or run{" "}
          <code className="font-mono">{signIn.command}</code> in a terminal.
        </span>
      )}
      {running && shown.length > 0 && (
        <pre
          className="m-0 max-h-[160px] basis-full overflow-auto whitespace-pre-wrap wrap-anywhere rounded-base border-2 border-[var(--line-strong)] bg-[var(--bg-code)] px-[10px] py-2 font-mono text-[12px]"
          aria-live="polite"
        >
          {shown.join("\n")}
        </pre>
      )}
      {login?.state === "failed" && (
        <Alert tone="error" className="basis-full">
          {login.error ?? "Sign-in failed."} You can also run{" "}
          <code className="font-mono">{signIn.command}</code> in a terminal.
        </Alert>
      )}
      {error && !confirming && (
        <Alert tone="error" className="basis-full">
          {error}
        </Alert>
      )}
    </>
  );
}

function ProviderRow({
  projectKey,
  provider,
  canSwitch,
  onChanged,
}: {
  projectKey: string;
  provider: ProviderStatus;
  canSwitch: boolean;
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
    <li className={LINE_LOOSE}>
      <Dot tone={provider.configured ? "ok" : ""} aria-hidden="true" />
      <span className={cn(GROW, COLUMN)}>
        <span>{provider.name}</span>
        <span className={cn("text-dim-foreground", NOTE)}>
          {provider.signIn
            ? signInView(provider.signIn).note
            : provider.configured
              ? provider.source === "env"
                ? "configured · key from an environment variable"
                : provider.source === "app"
                  ? "configured · key saved by BAKED"
                  : provider.source === "detected"
                    ? `configured · signed in through ${provider.detectedFrom ?? "another app"}`
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
          canSwitch={canSwitch}
          onChanged={onChanged}
        />
      )}
      {provider.keyUrl && !provider.configured && (
        <a href={provider.keyUrl} target="_blank" rel="noreferrer">
          Get a key
        </a>
      )}
      {provider.acceptsKey && !editing && (
        <Button variant="secondary" size="md" onClick={() => setEditing(true)}>
          {provider.source === "app" ? "Replace key" : "Set key"}
        </Button>
      )}
      {provider.acceptsKey && provider.source === "app" && !editing && (
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() => void run(() => setup.removeProviderKey(projectKey, provider.id))}
        >
          Remove key
        </Button>
      )}
      {editing && (
        <form
          className={cn(ADD, "basis-full")}
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
            className={KEY_INPUT}
            autoComplete="off"
            placeholder="Paste the API key"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" variant="primary" size="md" disabled={busy || !value.trim()}>
            Save
          </Button>
          <Button variant="secondary" size="md" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      )}
      {error && (
        <Alert tone="error" className="basis-full">
          {error}
        </Alert>
      )}
    </li>
  );
}

function Providers({ projectKey }: { projectKey: string }) {
  const [providers, reload] = useLoad(() => setup.providers(projectKey), [projectKey, "providers"]);
  const [canSwitch, setCanSwitch] = useState(false);
  useEffect(() => {
    let live = true;
    setup.canSwitchAccount(projectKey).then(
      (yes) => live && setCanSwitch(yes),
      () => live && setCanSwitch(false),
    );
    return () => {
      live = false;
    };
  }, [projectKey]);
  return (
    <section className={STACK} aria-label="Providers">
      {providers.state === "ready" ? (
        <ul className={cn(PANEL, LIST, FLUSH)}>
          {providers.data.providers.map((p) => (
            <ProviderRow
              key={p.id}
              projectKey={projectKey}
              provider={p}
              canSwitch={canSwitch}
              onChanged={reload}
            />
          ))}
        </ul>
      ) : (
        <LoadState value={providers} what="providers" />
      )}
    </section>
  );
}

function Telemetry({ config, patch, busy }: { config: ConfigView; patch: Patch; busy: boolean }) {
  const enabled = config.global.telemetry !== false;
  const url = config.effective.telemetryUrl;
  return (
    <section className={STACK} aria-label="Telemetry">
      <div className={cn(PANEL, STACK)}>
        <label className={CHECK}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void patch({ telemetry: e.target.checked })}
          />
          Record anonymous usage stats (version, OS, surface)
        </label>
        <span className={cn("text-dim-foreground", NOTE)}>
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
    <section className={STACK} aria-label="Run notifications">
      <div className={cn(PANEL, STACK)}>
        <label className={CHECK}>
          <input
            type="checkbox"
            checked={current.system !== false}
            disabled={busy}
            onChange={(e) => void save({ ...current, system: e.target.checked })}
          />
          Desktop notifications from the terminal app and the CLI
        </label>
        <form
          className={ADD}
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
            autoComplete="off"
            placeholder="https://example.com/hook"
            value={value}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={busy || !valid || value.trim() === url}
          >
            Save
          </Button>
          {url && (
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => {
                const { webhook: _removed, ...rest } = current;
                void save(rest).then((ok) => ok && setDraft(null));
              }}
            >
              Remove
            </Button>
          )}
        </form>
        {url && (
          <label className={CHECK}>
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
        <span className={cn("text-dim-foreground", NOTE)}>
          {url
            ? `Each waiting run is posted once to ${url} as JSON: run, feature, request kind, never its content.`
            : "No webhook: nothing is sent."}{" "}
          Headers such as a token go in notifications.webhook.headers of the config file.
        </span>
      </div>
    </section>
  );
}

type GlobalSection = Exclude<SettingsSection, "app" | "chat">;

/** Title and one-line explanation of each All projects page. */
const PAGES: Record<GlobalSection, { title: string; lede: ReactNode }> = {
  providers: {
    title: "Providers and keys",
    lede: "Sign in to the services that run the models, or give them an API key. Keys live in the system keychain or the environment, never in config files, and are never shown here.",
  },
  routing: {
    title: "Model routing",
    lede: "Which model does which job. Pick a default model for a kind of agent or a workflow step; anything left empty uses the model you choose when you start a run.",
  },
  commands: {
    title: "Global commands",
    lede: (
      <>
        Your own slash commands for every project: Markdown prompt templates in{" "}
        <span className="font-mono">~/.baked/commands/</span>.{" "}
        <span className="font-mono">fix-ci.md</span> becomes{" "}
        <span className="font-mono">/fix-ci</span>.
      </>
    ),
  },
  notifications: {
    title: "Run notifications",
    lede: "How you hear that a run waits for an approval, an answer or a budget extension. This app's own notifications are under This app and in the tray menu.",
  },
  telemetry: {
    title: "Telemetry",
    lede: "Anonymous usage stats that help improve BAKED.",
  },
};

export function GlobalSettings({ section }: { section: GlobalSection }) {
  const { projects } = useDesktop();
  const host = projects.find((p) => p.backend.kind === "running");
  if (!host)
    return (
      <>
        <h1>{PAGES[section].title}</h1>
        <Empty>
          Open a project to see these settings: any project's backend reads them from{" "}
          <span className="font-mono">~/.baked/config.json</span>.
        </Empty>
      </>
    );
  const running = projects
    .filter((p) => p.backend.kind === "running")
    .map((p) => ({ key: p.key, name: p.name }));
  return (
    <GlobalSettingsFor
      section={section}
      projectKey={host.key}
      projectName={host.name}
      projects={running}
    />
  );
}

function GlobalSettingsFor({
  section,
  projectKey,
  projectName,
  projects,
}: {
  section: GlobalSection;
  projectKey: string;
  projectName: string;
  /** Running projects; model routing resolves through the one picked there. */
  projects: RoutingProject[];
}) {
  const [config, , setConfig] = useLoad(() => setup.config(projectKey), [projectKey, "config"]);
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
  const page = PAGES[section];
  const needsConfig = section === "notifications" || section === "telemetry";
  return (
    <div className={SETUP}>
      <div className={cn(COLUMN, "gap-1")}>
        <h1>{page.title}</h1>
        <p className={LEDE}>{page.lede}</p>
        <span className={cn("text-dim-foreground", NOTE)}>
          Shared by every project on this computer, in{" "}
          <span className="font-mono">
            {section === "commands"
              ? "~/.baked/commands/"
              : config.state === "ready"
                ? config.data.paths.global
                : "~/.baked/config.json"}
          </span>
          . <Tag>read through {projectName}</Tag>
        </span>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {section === "providers" && <Providers projectKey={projectKey} />}
      {section === "routing" && <RoutingSection projects={projects} />}
      {section === "commands" && <GlobalCommands projectKey={projectKey} />}
      {needsConfig &&
        (config.state === "ready" ? (
          section === "notifications" ? (
            <Notifications config={config.data} patch={patch} busy={busy} />
          ) : (
            <Telemetry config={config.data} patch={patch} busy={busy} />
          )
        ) : config.state === "missing" ? (
          <NeedsNewer what="notifications or telemetry" />
        ) : (
          <LoadState value={config} what="the global config" />
        ))}
    </div>
  );
}
