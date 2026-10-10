import { type FormEvent, useState } from "react";
import {
  type ConfigView,
  EFFORTS,
  type Effort,
  type IndependentReview,
  type ModelRouting,
  type ProviderStatus,
  setup,
} from "../../client/setup.js";
import { useDesktop } from "../../store.js";
import "../../styles/setup.css";
import { type ClassRow, classRoute, classRows, commandLabel, splitList } from "./logic.js";
import { errorText, LoadState, NeedsNewer, Tag, useLoad } from "./shared.js";

/** Writes top-level keys of the global config; resolves to whether it worked. */
type Patch = (set: Record<string, unknown>) => Promise<boolean>;

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
          {provider.configured
            ? provider.source === "env"
              ? "configured · key from an environment variable"
              : provider.source === "app"
                ? "configured · key saved by BAKED"
                : "configured"
            : "not configured"}
          {!provider.acceptsKey && " · signs in without an API key"}
        </span>
      </span>
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

function ClassEditor({
  row,
  onSave,
  onRemove,
  onCancel,
  busy,
}: {
  row: ClassRow | null;
  onSave: (name: string, model: string, effort: Effort, fallback: string[]) => void;
  onRemove: (() => void) | null;
  onCancel: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState(row?.name ?? "");
  const [model, setModel] = useState(row?.model ?? "");
  const [effort, setEffort] = useState<Effort>(row?.effort ?? "default");
  const [fallback, setFallback] = useState(row?.fallback.join(", ") ?? "");
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    onSave(name.trim(), model.trim(), effort, splitList(fallback));
  };
  return (
    <form className="card setup-form" onSubmit={submit} aria-label="Model class">
      <div className="setup-pair">
        <div className="setup-fl">
          <label htmlFor="class-name">Class</label>
          <input
            id="class-name"
            type="text"
            className="mono"
            value={name}
            disabled={row !== null}
            placeholder="deep"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="setup-fl">
          <label htmlFor="class-effort">Effort</label>
          <select
            id="class-effort"
            value={effort}
            onChange={(e) => setEffort(e.target.value as Effort)}
          >
            {EFFORTS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="setup-fl">
        <label htmlFor="class-model">Model</label>
        <input
          id="class-model"
          type="text"
          className="mono"
          value={model}
          placeholder="anthropic/claude-opus-5-5"
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      <div className="setup-fl">
        <label htmlFor="class-fallback">Fallback models, in order (up to 3)</label>
        <input
          id="class-fallback"
          type="text"
          className="mono"
          value={fallback}
          placeholder="none"
          onChange={(e) => setFallback(e.target.value)}
        />
      </div>
      <div className="setup-actions">
        <button
          type="submit"
          className="btn-primary"
          disabled={busy || !model.trim() || !name.trim()}
        >
          Save
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        {onRemove && (
          <button type="button" className="btn" disabled={busy} onClick={onRemove}>
            Remove from config
          </button>
        )}
      </div>
    </form>
  );
}

function Routing({
  config,
  patch,
  busy,
  setError,
}: {
  config: ConfigView;
  patch: Patch;
  busy: boolean;
  setError: (message: string | null) => void;
}) {
  const routing: ModelRouting = config.global.modelRouting ?? {};
  const rows = classRows(routing);
  const [editing, setEditing] = useState<string | null>(null);
  const runModel = config.effective.defaultModel;
  const saveRouting = async (next: ModelRouting): Promise<void> => {
    if (await patch({ modelRouting: next })) setEditing(null);
  };
  const review: IndependentReview =
    routing.independentReview ?? (config.global.modelRouting ? "warn" : "off");
  const describe = (row: ClassRow): string => {
    if (row.model) return row.model;
    if (row.name === "active") return `tab model${runModel ? ` · ${runModel}` : ""}`;
    return "run model (not set)";
  };
  const editingRow = editing === "+" ? null : (rows.find((r) => r.name === editing) ?? null);
  return (
    <section className="setup-section" aria-labelledby="routing">
      <h2 id="routing" className="setup-h2">
        Model routing
      </h2>
      <p className="lede">
        Defaults for every project; a project can override them in its own{" "}
        <span className="mono">.baked/config.json</span>.
      </p>
      <h3 className="label">Classes</h3>
      <div className="card setup-flush setup-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Class</th>
              <th>Model</th>
              <th>Effort</th>
              <th>Fallback</th>
              <th>Used by</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="mono">
            {rows.map((row) => (
              <tr key={row.name}>
                <td>${row.name}</td>
                <td className={row.model ? "setup-cell" : "setup-cell muted"}>{describe(row)}</td>
                <td>{row.effort}</td>
                <td className="setup-cell">
                  {row.fallback.length ? row.fallback.join(", ") : "–"}
                </td>
                <td className="setup-cell">{row.usedBy.length ? row.usedBy.join(", ") : "–"}</td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setEditing(row.name)}
                    aria-label={`Edit $${row.name}`}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing === null ? (
        <div>
          <button type="button" className="btn" onClick={() => setEditing("+")}>
            Add class
          </button>
        </div>
      ) : (
        <ClassEditor
          key={editing}
          row={editingRow}
          busy={busy}
          onCancel={() => setEditing(null)}
          onRemove={
            editingRow?.model
              ? () => {
                  const classes = { ...routing.classes };
                  delete classes[editingRow.name];
                  void saveRouting({ ...routing, classes });
                }
              : null
          }
          onSave={(name, model, effort, fallback) => {
            if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
              setError(
                "Class names are lowercase letters, digits and '-', starting with a letter.",
              );
              return;
            }
            if (model.startsWith("$")) {
              setError("A class names a model, not another class.");
              return;
            }
            if (fallback.length > 3) {
              setError("Up to three fallback models.");
              return;
            }
            void saveRouting({
              ...routing,
              classes: { ...routing.classes, [name]: classRoute(model, effort, fallback) },
            });
          }}
        />
      )}
      <div className="card setup-row">
        <span className="setup-grow stack">
          <span>Independent review</span>
          <span className="muted setup-note">
            What happens when a reviewer would run on a model the implementation also uses.
          </span>
        </span>
        <fieldset className="seg-group" aria-label="Independent review">
          {(["off", "warn", "require"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="seg"
              aria-pressed={review === mode}
              disabled={busy}
              onClick={() => void saveRouting({ ...routing, independentReview: mode })}
            >
              {mode}
            </button>
          ))}
        </fieldset>
      </div>
    </section>
  );
}

function RouteExplanation({
  projectKey,
  projectName,
  config,
}: {
  projectKey: string;
  projectName: string;
  config: ConfigView;
}) {
  const [definitions] = useLoad(() => setup.definitions(projectKey), [projectKey]);
  const [workflow, setWorkflow] = useState("sdd");
  const configKey = JSON.stringify(config.effective.modelRouting ?? null);
  const [route] = useLoad(
    () => setup.route(projectKey, workflow),
    [projectKey, workflow, configKey],
  );
  const ids =
    definitions.state === "ready"
      ? definitions.data.map((d) => d.id)
      : ["sdd", "quick", "standard"];
  const override = config.project.modelRouting;
  return (
    <section className="setup-section" aria-labelledby="route">
      <div className="setup-row">
        <h3 id="route" className="label setup-grow">
          Who runs each stage of {workflow}
        </h3>
        <label htmlFor="route-workflow" className="sr-only">
          Workflow
        </label>
        <select id="route-workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
          {ids.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
      {route.state === "ready" ? (
        <>
          <div className="card setup-flush setup-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Model</th>
                  <th>Chosen by</th>
                </tr>
              </thead>
              <tbody>
                {route.data.stages.map((stage) => (
                  <tr key={stage.stageId}>
                    <td>{stage.stageId}</td>
                    <td className="mono">
                      {stage.model ?? <span className="muted">each agent's profile</span>}
                      {stage.effort && stage.effort !== "default" ? ` · ${stage.effort}` : ""}
                    </td>
                    <td className="muted">{stage.source ?? "profiles"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {route.data.warnings.length ? (
            <ul className="setup-warn setup-note setup-plain">
              {route.data.warnings.map((w) => (
                <li key={w}>! {w}</li>
              ))}
            </ul>
          ) : (
            <span className="setup-ok setup-note">
              ✓ Reviewers use a different model from the implementer.
            </span>
          )}
          <span className="muted setup-note">
            As routed for {projectName}, with run model{" "}
            <span className="mono">{route.data.runModel}</span>.
          </span>
        </>
      ) : (
        <LoadState value={route} what="the route explanation" />
      )}
      {override && (
        <div className="card setup-row">
          <span className="dot warn" aria-hidden="true" />
          <span className="setup-grow">
            {projectName} overrides model routing in its own{" "}
            <span className="mono">.baked/config.json</span>; the table above includes it.
          </span>
        </div>
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

/** In-page targets; buttons rather than `#id` links, which the hash router would take. */
const TOC = [
  ["providers", "Providers and keys"],
  ["routing", "Model routing"],
  ["commands", "Global commands"],
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
  return <GlobalSettingsFor projectKey={host.key} projectName={host.name} />;
}

function GlobalSettingsFor({
  projectKey,
  projectName,
}: {
  projectKey: string;
  projectName: string;
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
          <Routing config={config.data} patch={patch} busy={busy} setError={setError} />
          <RouteExplanation
            projectKey={projectKey}
            projectName={projectName}
            config={config.data}
          />
          <GlobalCommands projectKey={projectKey} />
          <Telemetry config={config.data} patch={patch} busy={busy} />
        </>
      ) : config.state === "missing" ? (
        <>
          <NeedsNewer what="model routing, global commands or telemetry" />
          <GlobalCommands projectKey={projectKey} />
        </>
      ) : (
        <LoadState value={config} what="the global config" />
      )}
    </div>
  );
}
