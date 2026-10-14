import { createContext, type FormEvent, useContext, useEffect, useState } from "react";
import { chat } from "../../client/chat.js";
import {
  type SettingDefinition,
  type SettingScope,
  type SettingsChange,
  type SettingsView,
  type SettingValue,
  settingsApi,
} from "../../client/settings.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { ModelListPicker, ModelPicker, useModelCatalog } from "../../components/ui/model-picker.js";
import { Switch } from "../../components/ui/switch.js";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { Textarea } from "../../components/ui/textarea.js";
import { Hint } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import { useDesktop } from "../../store.js";
import {
  dependencyNote,
  displayNumber,
  isActive,
  type LibraryDocsDraft,
  libraryDocsDraft,
  libraryDocsSummary,
  lockedReason,
  numberDraft,
  orderError,
  pageSections,
  parseLibraryDocs,
  parseNumber,
  scopeValue,
  setInScope,
  sourceLabel,
} from "./chat-settings-logic.js";
import { errorText, LoadState, NOTE, OK, SETUP, STACK, Tag, useLoad } from "./shared.js";

type Models = ReturnType<typeof useModelCatalog>;
type Change = (change: SettingsChange, what: string) => Promise<boolean>;

/** The backend's answer to the last refused change, shown again inside an open edit dialog. */
const ChangeError = createContext<{ error: string | null; clear: () => void }>({
  error: null,
  clear: () => {},
});

const SCOPES: { scope: SettingScope; label: string }[] = [
  { scope: "global", label: "All projects" },
  { scope: "project", label: "This project" },
];
const SCOPE_HINT =
  "All projects writes ~/.baked/config.json. This project writes the project's .baked/config.json, which wins over All projects setting by setting. Reset removes the value from the file you edit, so the other file or the default applies.";

const ROW =
  "flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--line)] py-[10px] last:border-b-0";
const CONTROL = "flex flex-wrap items-center gap-2";

/**
 * Settings > Chat: the chat settings the terminal edits in its pickers, one page per page of the
 * backend's settings schema (`GET /v1/settings`). Each control writes one setting to the global or
 * one project's config; the backend validates it and new chat turns use it at once.
 */
export function ChatSettings({ page }: { page: string | null }) {
  const { projects } = useDesktop();
  const running = projects
    .filter((p) => p.backend.kind === "running")
    .map((p) => ({ key: p.key, name: p.name }));
  if (running.length === 0)
    return (
      <>
        <h1>Chat settings</h1>
        <Empty>
          Open a project to see these settings: its backend reads them from{" "}
          <span className="font-mono">~/.baked/config.json</span> and the project's{" "}
          <span className="font-mono">.baked/config.json</span>.
        </Empty>
      </>
    );
  return <ChatSettingsFor page={page} projects={running} />;
}

function ChatSettingsFor({
  page,
  projects,
}: {
  page: string | null;
  projects: { key: string; name: string }[];
}) {
  const [projectKey, setProjectKey] = useState(projects[0]?.key ?? "");
  const project = projects.find((p) => p.key === projectKey) ?? projects[0];
  const key = project?.key ?? "";
  const [scope, setScope] = useState<SettingScope>("global");
  const [view, , setView] = useLoad(() => settingsApi.load(key), [key, "chat-settings"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const models = useModelCatalog(key || null, chat.models);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page clears the last result.
  useEffect(() => {
    setSaved(null);
    setError(null);
  }, [page]);

  const change: Change = async (next, what) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      setView(await settingsApi.change(key, scope, next));
      setSaved(what);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (view.state !== "ready")
    return (
      <div className={SETUP}>
        <h1>Chat settings</h1>
        <LoadState value={view} what="chat settings" />
      </div>
    );
  const pages = view.data.pages;
  const current = pages.find((p) => p.id === page) ?? pages[0];
  if (!current)
    return (
      <div className={SETUP}>
        <h1>Chat settings</h1>
        <Empty>This BAKED describes no chat settings.</Empty>
      </div>
    );
  const file = scope === "global" ? "~/.baked/config.json" : ".baked/config.json";
  const layerName = scope === "global" ? "All projects" : (project?.name ?? "this project");

  return (
    <div className={SETUP}>
      <div className={cn(STACK, "gap-1")}>
        <h1>{current.title}</h1>
        <p className={LEDE}>{current.description}</p>
        <span className={cn("text-dim-foreground", NOTE)}>
          The same settings as <span className="font-mono">{current.command}</span> in the terminal.
          New chat turns use a change at once.
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className={cn(LABEL, "flex items-center")}>
            Save changes to
            <Hint label="where changes are saved">{SCOPE_HINT}</Hint>
          </span>
          <Tabs
            value={scope}
            onValueChange={(value) => {
              setScope(value as SettingScope);
              setSaved(null);
              setError(null);
            }}
          >
            <TabsList aria-label="Layer">
              {SCOPES.map((layer) => (
                <TabsTrigger key={layer.scope} value={layer.scope}>
                  {layer.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        {projects.length > 1 && (
          <div className="flex flex-col gap-1">
            <label htmlFor="chat-settings-project" className={LABEL}>
              Project
            </label>
            <select
              id="chat-settings-project"
              value={key}
              onChange={(e) => setProjectKey(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <span className={cn("text-dim-foreground", NOTE)}>
        Editing <strong>{layerName}</strong> in <span className="font-mono">{file}</span>
      </span>
      {error && (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      )}
      {saved && (
        <output className={cn(OK, NOTE)}>
          ✓ {saved} in {layerName}.
        </output>
      )}
      <ChangeError.Provider value={{ error, clear: () => setError(null) }}>
        {pageSections(view.data, current.id).map((section) => (
          <section
            key={section.title}
            className={cn(PANEL, "flex flex-col py-[6px]")}
            aria-label={section.title}
          >
            <h2 className={cn(LABEL, "pt-2 pb-1")}>{section.title}</h2>
            {section.settings.map((setting) => (
              <SettingRow
                key={setting.id}
                setting={setting}
                view={view.data}
                scope={scope}
                busy={busy}
                models={models}
                change={change}
              />
            ))}
          </section>
        ))}
      </ChangeError.Provider>
    </div>
  );
}

function SettingRow({
  setting,
  view,
  scope,
  busy,
  models,
  change,
}: {
  setting: SettingDefinition;
  view: SettingsView;
  scope: SettingScope;
  busy: boolean;
  models: Models;
  change: Change;
}) {
  const value = view.values[setting.id];
  const locked = lockedReason(setting, scope);
  const active = isActive(setting, view.values);
  const note = active ? null : dependencyNote(setting, view);
  const check = view.checks?.[setting.id];
  const disabled = busy || locked !== null;
  const wide = setting.type === "string-list" || setting.type.endsWith("-map");
  return (
    // A group named after the setting, so its Edit, Change and Reset buttons are told apart.
    <fieldset
      className={cn(ROW, "m-0 min-w-0 border-x-0 border-t-0 px-0", wide && "items-start")}
      aria-label={setting.label}
      data-setting={setting.id}
    >
      <div className={cn("flex min-w-[220px] flex-1 flex-col gap-[2px]", !active && "opacity-60")}>
        <span className="flex items-center text-[14px] font-semibold text-foreground">
          {setting.label}
          <Hint label={setting.label}>{setting.help}</Hint>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {value && <Tag>{sourceLabel(value.source)}</Tag>}
          {locked && <Tag tone="warn">{locked}</Tag>}
          {note && <span className={cn("text-dim-foreground", NOTE)}>{note}</span>}
        </span>
        {check && (
          <span
            className={cn(
              check.status === "ok" ? "text-dim-foreground" : "text-[var(--warn)]",
              NOTE,
            )}
          >
            {check.title}
            {check.detail ? `: ${check.detail}` : ""}
            {check.fix ? `. ${check.fix}` : ""}
          </span>
        )}
      </div>
      <div className={cn(CONTROL, wide && "w-full")}>
        <SettingControl
          setting={setting}
          value={value}
          view={view}
          scope={scope}
          disabled={disabled}
          models={models}
          change={change}
        />
        {setting.type !== "secret" && setInScope(value, scope) && (
          <Button
            variant="secondary"
            size="md"
            disabled={disabled}
            onClick={() => void change({ reset: [setting.id] }, `Reset ${setting.label}`)}
          >
            Reset
          </Button>
        )}
      </div>
    </fieldset>
  );
}

function SettingControl({
  setting,
  value,
  view,
  scope,
  disabled,
  models,
  change,
}: {
  setting: SettingDefinition;
  value: SettingValue | undefined;
  view: SettingsView;
  scope: SettingScope;
  disabled: boolean;
  models: Models;
  change: Change;
}) {
  const current = value?.value;
  switch (setting.type) {
    case "boolean":
      return (
        <Switch
          aria-label={setting.label}
          checked={current === true}
          disabled={disabled}
          onCheckedChange={(on) =>
            void change({ set: { [setting.id]: on } }, `${setting.label} ${on ? "on" : "off"}`)
          }
        />
      );
    case "enum":
      return (
        <select
          aria-label={setting.label}
          value={String(current ?? setting.default)}
          disabled={disabled}
          onChange={(e) =>
            void change({ set: { [setting.id]: e.target.value } }, `Saved ${setting.label}`)
          }
        >
          {setting.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
              {option.help ? ` — ${option.help}` : ""}
            </option>
          ))}
        </select>
      );
    case "number":
      return (
        <NumberEditor
          setting={setting}
          current={current}
          disabled={disabled}
          change={change}
          view={view}
        />
      );
    case "model":
      return (
        <ModelEditor
          setting={setting}
          current={typeof current === "string" ? current : null}
          disabled={disabled}
          models={models}
          change={change}
        />
      );
    case "string-list":
      return (
        <ToolList
          setting={setting}
          view={view}
          off={scopeValue<string[]>(value, scope, [...setting.default])}
          disabled={disabled}
          change={change}
        />
      );
    case "model-list-map":
    case "model-number-map":
      return (
        <MapEditor
          setting={setting}
          map={scopeValue<Record<string, unknown>>(value, scope, {})}
          disabled={disabled}
          models={models}
          change={change}
        />
      );
    case "secret":
      return (
        <SecretEditor
          setting={setting}
          isSet={current === true}
          disabled={disabled}
          change={change}
        />
      );
    case "library-docs":
      return (
        <LibraryDocsEditor
          setting={setting}
          current={current}
          disabled={disabled}
          change={change}
        />
      );
  }
}

function EditDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const changeError = useContext(ChangeError);
  const { clear } = changeError;
  // An error from before the dialog opened belongs to the page, not to this edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only opening the dialog clears it.
  useEffect(() => {
    if (open) clear();
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {changeError.error && (
            <Alert tone="error" role="alert">
              {changeError.error}
            </Alert>
          )}
          {children}
        </DialogContent>
      )}
    </Dialog>
  );
}

function DialogActions({
  disabled,
  onCancel,
  extra,
}: {
  disabled: boolean;
  onCancel: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {extra}
      <Button variant="secondary" size="md" type="button" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="primary" size="md" type="submit" disabled={disabled}>
        Save
      </Button>
    </div>
  );
}

function NumberEditor({
  setting,
  current,
  disabled,
  change,
  view,
}: {
  setting: SettingDefinition;
  current: unknown;
  disabled: boolean;
  change: Change;
  view: SettingsView;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const read = parseNumber(setting, draft);
  const order = "error" in read ? null : orderError(setting, read.value, view);
  const parsed = order ? { error: order } : read;
  const unit = setting.type === "number" ? setting.display?.unit : undefined;
  const id = `setting-${setting.id}`;
  const invalid = "error" in parsed && draft.trim() !== "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if ("error" in parsed) return;
    void change({ set: { [setting.id]: parsed.value } }, `Saved ${setting.label}`).then(
      (ok) => ok && setOpen(false),
    );
  };
  return (
    <>
      <span className="font-mono text-[13px] text-foreground">
        {displayNumber(setting, current)}
      </span>
      <Button
        variant="secondary"
        size="md"
        disabled={disabled}
        onClick={() => {
          setDraft(numberDraft(setting, current));
          setOpen(true);
        }}
      >
        Edit
      </Button>
      <EditDialog
        open={open}
        onOpenChange={setOpen}
        title={setting.label}
        description={setting.help}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={id}>
              {setting.label}
              {unit ? ` (${unit})` : ""}
            </Label>
            <Input
              id={id}
              inputMode="decimal"
              value={draft}
              placeholder={setting.type === "number" && setting.nullable ? "auto" : ""}
              aria-invalid={invalid || undefined}
              aria-describedby={`${id}-note`}
              onChange={(e) => setDraft(e.target.value)}
            />
            <span
              id={`${id}-note`}
              className={cn(invalid ? "text-[var(--err)]" : "text-dim-foreground", NOTE)}
            >
              {"error" in parsed && invalid
                ? parsed.error
                : setting.type === "number"
                  ? `From ${displayNumber(setting, setting.min)} to ${displayNumber(setting, setting.max)}${setting.nullable ? "; leave empty for auto" : ""}.`
                  : ""}
            </span>
          </div>
          <DialogActions disabled={disabled || "error" in parsed} onCancel={() => setOpen(false)} />
        </form>
      </EditDialog>
    </>
  );
}

function ModelEditor({
  setting,
  current,
  disabled,
  models,
  change,
}: {
  setting: SettingDefinition;
  current: string | null;
  disabled: boolean;
  models: Models;
  change: Change;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const id = `setting-${setting.id}`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const model = draft.trim();
    void change({ set: { [setting.id]: model || null } }, `Saved ${setting.label}`).then(
      (ok) => ok && setOpen(false),
    );
  };
  return (
    <>
      <span
        className={cn("font-mono text-[13px]", current ? "text-foreground" : "text-dim-foreground")}
      >
        {current ?? "not set"}
      </span>
      <Button
        variant="secondary"
        size="md"
        disabled={disabled}
        onClick={() => {
          setDraft(current ?? "");
          setOpen(true);
        }}
      >
        {current ? "Change" : "Choose"}
      </Button>
      <EditDialog
        open={open}
        onOpenChange={setOpen}
        title={setting.label}
        description={setting.help}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={id}>Model</Label>
            <ModelPicker
              id={id}
              value={draft}
              onChange={setDraft}
              catalog={models.catalog}
              error={models.error}
              placeholder="provider/model"
            />
            <span className={cn("text-dim-foreground", NOTE)}>Leave empty to unset it.</span>
          </div>
          <DialogActions disabled={disabled} onCancel={() => setOpen(false)} />
        </form>
      </EditDialog>
    </>
  );
}

function ToolList({
  setting,
  view,
  off,
  disabled,
  change,
}: {
  setting: SettingDefinition;
  view: SettingsView;
  off: string[];
  disabled: boolean;
  change: Change;
}) {
  const disabledSet = new Set(off);
  const tools = setting.type === "string-list" ? (view.catalogs[setting.catalog] ?? []) : [];
  return (
    <ul className="m-0 grid w-full list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-4 gap-y-2 p-0">
      {tools.map((tool) => {
        const on = !disabledSet.has(tool.name);
        return (
          <li key={tool.name} className="flex items-start gap-2">
            <Switch
              aria-label={tool.name}
              checked={on}
              disabled={disabled}
              onCheckedChange={(next) => {
                const updated = next
                  ? off.filter((name) => name !== tool.name)
                  : [...off, tool.name];
                void change(
                  { set: { [setting.id]: updated } },
                  `${tool.name} ${next ? "on" : "off"}`,
                );
              }}
            />
            <span className="flex min-w-0 flex-col">
              <span className="font-mono text-[13px] text-foreground">{tool.name}</span>
              <span className={cn("text-dim-foreground", NOTE)}>{tool.description}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function MapEditor({
  setting,
  map,
  disabled,
  models,
  change,
}: {
  setting: SettingDefinition;
  map: Record<string, unknown>;
  disabled: boolean;
  models: Models;
  change: Change;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [list, setList] = useState<string[]>([]);
  const [tokens, setTokens] = useState("");
  const lists = setting.type === "model-list-map";
  const entries = Object.entries(map);
  const open = (name: string | null) => {
    setModel(name ?? "");
    setList(name && Array.isArray(map[name]) ? (map[name] as string[]) : []);
    setTokens(name && typeof map[name] === "number" ? String(map[name]) : "");
    setEditing(name ?? "");
  };
  const save = (next: Record<string, unknown>, what: string) =>
    change({ set: { [setting.id]: next } }, what);
  const count = Number(tokens.replace(/[,_\s]/g, ""));
  const range = setting.type === "model-number-map" ? setting : null;
  const tokensOk = !range || (Number.isInteger(count) && count >= range.min && count <= range.max);
  const valid = model.trim() !== "" && (lists ? list.length > 0 : tokensOk);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const next = { ...map };
    if (editing && editing !== model.trim()) delete next[editing];
    next[model.trim()] = lists ? list : count;
    void save(next, `Saved ${model.trim()}`).then((ok) => ok && setEditing(null));
  };
  return (
    <div className="flex w-full flex-col gap-2">
      {entries.length === 0 ? (
        <span className={cn("text-dim-foreground", NOTE)}>None yet.</span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {entries.map(([name, entry]) => (
            <li key={name} className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-mono text-foreground">{name}</span>
              <span className="text-dim-foreground">→</span>
              <span className="font-mono text-soft-foreground">
                {Array.isArray(entry)
                  ? entry.join(", ")
                  : `${Number(entry).toLocaleString("en-US")} tokens`}
              </span>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => open(name)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  const next = { ...map };
                  delete next[name];
                  void save(next, `Removed ${name}`);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="secondary" size="md" disabled={disabled} onClick={() => open(null)}>
          {lists ? "Add fallback chain" : "Add override"}
        </Button>
      </div>
      <EditDialog
        open={editing !== null}
        onOpenChange={(next) => !next && setEditing(null)}
        title={setting.label}
        description={setting.help}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${setting.id}-model`}>Model</Label>
            <ModelPicker
              id={`${setting.id}-model`}
              value={model}
              onChange={setModel}
              catalog={models.catalog}
              error={models.error}
              placeholder="provider/model"
            />
          </div>
          {lists ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${setting.id}-list`}>Fallbacks, in order</Label>
              <ModelListPicker
                id={`${setting.id}-list`}
                value={list}
                onChange={setList}
                catalog={models.catalog}
                error={models.error}
                max={10}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${setting.id}-tokens`}>Context window (tokens)</Label>
              <Input
                id={`${setting.id}-tokens`}
                inputMode="numeric"
                value={tokens}
                placeholder="200000"
                aria-invalid={(!tokensOk && tokens.trim() !== "") || undefined}
                aria-describedby={`${setting.id}-tokens-error`}
                onChange={(e) => setTokens(e.target.value)}
              />
              {!tokensOk && tokens.trim() !== "" && range && (
                <span id={`${setting.id}-tokens-error`} className={cn("text-[var(--err)]", NOTE)}>
                  A whole number from {range.min.toLocaleString("en-US")} to{" "}
                  {range.max.toLocaleString("en-US")}.
                </span>
              )}
            </div>
          )}
          <DialogActions disabled={disabled || !valid} onCancel={() => setEditing(null)} />
        </form>
      </EditDialog>
    </div>
  );
}

function LibraryDocsEditor({
  setting,
  current,
  disabled,
  change,
}: {
  setting: SettingDefinition;
  current: unknown;
  disabled: boolean;
  change: Change;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LibraryDocsDraft>(libraryDocsDraft(null));
  const parsed = parseLibraryDocs(draft);
  const id = `setting-${setting.id}`;
  const edit = (field: keyof LibraryDocsDraft) => (e: { target: { value: string } }) =>
    setDraft((prev) => ({ ...prev, [field]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if ("error" in parsed) return;
    void change({ set: { [setting.id]: parsed.value } }, `Saved ${setting.label}`).then(
      (ok) => ok && setOpen(false),
    );
  };
  return (
    <>
      <span
        className={cn("font-mono text-[13px]", current ? "text-foreground" : "text-dim-foreground")}
      >
        {libraryDocsSummary(current)}
      </span>
      <Button
        variant="secondary"
        size="md"
        disabled={disabled}
        onClick={() => {
          setDraft(libraryDocsDraft(current));
          setOpen(true);
        }}
      >
        Edit
      </Button>
      <EditDialog
        open={open}
        onOpenChange={setOpen}
        title={setting.label}
        description={setting.help}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-kind`}>Source</Label>
            <select id={`${id}-kind`} value={draft.kind} onChange={edit("kind")}>
              <option value="none">None</option>
              <option value="dir">Directory of Markdown files</option>
              <option value="mcp">MCP tool</option>
            </select>
          </div>
          {draft.kind === "dir" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-dir`}>Directory</Label>
              <Input
                id={`${id}-dir`}
                value={draft.dir}
                placeholder="docs/libraries"
                onChange={edit("dir")}
              />
              <span className={cn("text-dim-foreground", NOTE)}>
                Absolute, relative to the project, or starting with ~.
              </span>
            </div>
          )}
          {draft.kind === "mcp" && (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-server`}>Server</Label>
                <Input
                  id={`${id}-server`}
                  value={draft.server}
                  placeholder="context7"
                  onChange={edit("server")}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-tool`}>Tool</Label>
                <Input id={`${id}-tool`} value={draft.tool} onChange={edit("tool")} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-args`}>Arguments</Label>
                <Textarea
                  id={`${id}-args`}
                  rows={3}
                  value={draft.args}
                  placeholder={"libraryName={name}\nversion={version}"}
                  onChange={edit("args")}
                />
                <span className={cn("text-dim-foreground", NOTE)}>
                  One key=value per line; {"{name}"}, {"{version}"} and {"{ecosystem}"} are
                  replaced.
                </span>
              </div>
            </>
          )}
          {draft.kind !== "none" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-max`}>Max characters per library</Label>
              <Input
                id={`${id}-max`}
                inputMode="numeric"
                value={draft.maxChars}
                placeholder="8000"
                onChange={edit("maxChars")}
              />
            </div>
          )}
          {"error" in parsed && (
            <span role="alert" className={cn("text-[var(--err)]", NOTE)}>
              {parsed.error}
            </span>
          )}
          <DialogActions disabled={disabled || "error" in parsed} onCancel={() => setOpen(false)} />
        </form>
      </EditDialog>
    </>
  );
}

function SecretEditor({
  setting,
  isSet,
  disabled,
  change,
}: {
  setting: SettingDefinition;
  isSet: boolean;
  disabled: boolean;
  change: Change;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const id = `setting-${setting.id}`;
  const envVar = setting.type === "secret" ? setting.envVar : "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    void change({ set: { [setting.id]: draft.trim() } }, `Saved ${setting.label}`).then((ok) => {
      if (ok) {
        setDraft("");
        setOpen(false);
      }
    });
  };
  return (
    <>
      <Badge tone={isSet ? "ok" : "neutral"}>{isSet ? "set" : "not set"}</Badge>
      <Button variant="secondary" size="md" disabled={disabled} onClick={() => setOpen(true)}>
        {isSet ? "Replace key" : "Add key"}
      </Button>
      {isSet && (
        <Button
          variant="secondary"
          size="md"
          disabled={disabled}
          onClick={() => void change({ reset: [setting.id] }, `Removed ${setting.label}`)}
        >
          Remove
        </Button>
      )}
      <EditDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setDraft("");
        }}
        title={setting.label}
        description={`${setting.help} Stored in the system keychain (or BAKED's secrets file), never in a config file, and never shown again. ${envVar} in the environment also works.`}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={id}>Key</Label>
            <Input
              id={id}
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <DialogActions disabled={disabled || !draft.trim()} onCancel={() => setOpen(false)} />
        </form>
      </EditDialog>
    </>
  );
}
