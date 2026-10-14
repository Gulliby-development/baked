import { useEffect, useState } from "react";
import { type CommandEntry, setup } from "../../client/setup.js";
import { Icon } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/cn.js";
import { PANEL } from "../../lib/styles.js";
import {
  BLANK_COMMAND,
  type CommandForm,
  commandFormProblem,
  commandLabel,
  commandSlashName,
} from "./logic.js";
import {
  errorText,
  FIELD_HALF,
  FL,
  FLUSH,
  GROW,
  LINE,
  LIST,
  LoadState,
  NOTE,
  PAIR,
  STACK,
  useLoad,
  WRAP,
} from "./shared.js";

/** The dialog: a new command, or the command `name` being edited. */
type Editing = { name: string | null; form: CommandForm };

/**
 * Settings > Global commands: the slash commands of `~/.baked/commands/`, added, edited and removed
 * through the backend (`commands-edit`); an older backend only lists them.
 */
export function GlobalCommands({ projectKey }: { projectKey: string }) {
  const [commands, , setCommands] = useLoad(
    () => setup.commands(projectKey),
    [projectKey, "commands"],
  );
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<CommandEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void setup.canEditCommands(projectKey).then(
      (yes) => live && setCanEdit(yes),
      () => live && setCanEdit(false),
    );
    return () => {
      live = false;
    };
  }, [projectKey]);
  const global =
    commands.state === "ready" ? commands.data.commands.filter((c) => c.scope === "global") : [];

  const write = async (action: () => Promise<{ commands: CommandEntry[] }>, done: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setCommands({ commands: next.commands });
      done();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = async (command: CommandEntry) => {
    setError(null);
    try {
      const draft = await setup.command(projectKey, "global", command.name);
      setEditing({
        name: command.name,
        form: {
          name: draft.name.replace(/^\//, ""),
          description: draft.description,
          argumentHint: draft.argumentHint,
          body: draft.body,
        },
      });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const save = () => {
    if (!editing) return;
    const { name, form } = editing;
    void write(
      () =>
        name
          ? setup.updateCommand(projectKey, "global", name, form)
          : setup.addCommand(projectKey, "global", form),
      () => setEditing(null),
    );
  };

  return (
    <section className={STACK} aria-label="Global commands">
      {canEdit && (
        <div>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setError(null);
              setEditing({ name: null, form: BLANK_COMMAND });
            }}
          >
            <Icon name="new" size={14} /> New command
          </Button>
        </div>
      )}
      {error && !editing && !removing && <Alert tone="error">{error}</Alert>}
      {commands.state !== "ready" ? (
        <LoadState value={commands} what="the command list" />
      ) : global.length === 0 ? (
        <Empty>
          No global commands.{" "}
          {canEdit
            ? "Add one with New command, or put Markdown files in ~/.baked/commands/."
            : "Put Markdown files in ~/.baked/commands/."}
        </Empty>
      ) : (
        <ul className={cn(PANEL, LIST, FLUSH)}>
          {global.map((c) => (
            <li key={c.path} className={LINE}>
              <span className="font-mono">
                {commandLabel(c.name)}
                {c.argumentHint ? (
                  <span className="text-dim-foreground"> {c.argumentHint}</span>
                ) : null}
              </span>
              <span className={cn("text-dim-foreground", GROW)}>{c.description}</span>
              <span className={cn("font-mono text-dim-foreground", NOTE, WRAP)}>{c.path}</span>
              {canEdit && (
                <span className="flex shrink-0 gap-1">
                  <Tooltip content="Edit">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${commandLabel(c.name)}`}
                      onClick={() => void edit(c)}
                    >
                      <Icon name="edit" />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Delete">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${commandLabel(c.name)}`}
                      onClick={() => {
                        setError(null);
                        setRemoving(c);
                      }}
                    >
                      <Icon name="delete" />
                    </Button>
                  </Tooltip>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <CommandDialog
        editing={editing}
        taken={global.map((c) => c.name).filter((name) => name !== editing?.name)}
        busy={busy}
        error={editing ? error : null}
        onChange={(form) => editing && setEditing({ ...editing, form })}
        onSave={save}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`Delete ${removing ? commandLabel(removing.name) : "this command"}?`}
        confirmLabel="Delete"
        danger
        busy={busy}
        error={removing ? error : null}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          void write(
            () => setup.removeCommand(projectKey, "global", removing.name),
            () => setRemoving(null),
          )
        }
      >
        The command is gone from every project. Its file{" "}
        <span className={cn("font-mono", WRAP)}>{removing?.path}</span> is deleted.
      </ConfirmDialog>
    </section>
  );
}

function CommandDialog({
  editing,
  taken,
  busy,
  error,
  onChange,
  onSave,
  onClose,
}: {
  editing: Editing | null;
  taken: string[];
  busy: boolean;
  error: string | null;
  onChange: (form: CommandForm) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const form = editing?.form ?? BLANK_COMMAND;
  const problem = commandFormProblem(form, taken);
  const set = (key: keyof CommandForm, value: string) => onChange({ ...form, [key]: value });
  // A typed name is shown as soon as it is valid, so the slash name is clear before saving.
  const slash = form.name.trim() ? commandSlashName(form.name) : "/name";
  return (
    <Dialog open={editing !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="w-[min(640px,calc(100vw-48px))]">
        <DialogHeader>
          <DialogTitle>
            {editing?.name ? `Edit ${commandLabel(editing.name)}` : "New command"}
          </DialogTitle>
          <DialogDescription>
            A prompt you run as <span className="font-mono">{slash}</span> in every project.{" "}
            <span className="font-mono">$ARGUMENTS</span> and <span className="font-mono">$1</span>{" "}
            to <span className="font-mono">$9</span> take what follows the name.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem) onSave();
          }}
        >
          <div className={PAIR}>
            <div className={FIELD_HALF}>
              <label htmlFor="command-name">Name</label>
              <Input
                id="command-name"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="fix-ci"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </div>
            <div className={FIELD_HALF}>
              <label htmlFor="command-hint">Argument hint</label>
              <Input
                id="command-hint"
                className="font-mono"
                autoComplete="off"
                placeholder="<job name>"
                value={form.argumentHint}
                onChange={(e) => set("argumentHint", e.target.value)}
              />
            </div>
          </div>
          <div className={FL}>
            <label htmlFor="command-description">Description</label>
            <Input
              id="command-description"
              autoComplete="off"
              placeholder="Fix the failing CI job"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className={FL}>
            <label htmlFor="command-body">Prompt</label>
            <Textarea
              id="command-body"
              className="min-h-[140px] font-mono text-[13px]"
              placeholder="Find why the CI job $1 fails and fix it."
              value={form.body}
              onChange={(e) => set("body", e.target.value)}
            />
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {problem && <span className={cn(NOTE, "mr-auto text-dim-foreground")}>{problem}</span>}
            <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={busy || problem !== null}>
              {busy ? "Saving…" : editing?.name ? "Save changes" : "Add command"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
