import { useEffect, useMemo, useState } from "react";
import type { NewProjectCheck } from "../../shared/api.js";
import { bridge } from "../client/bridge.js";
import { projectHref } from "../router.js";
import { useDesktop } from "../store.js";
import { defaultLocation, draftOf, folderOf, type NewProjectForm } from "./new-project-model.js";
import { Alert } from "./ui/alert.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Switch } from "./ui/switch.js";

const FIELD = "flex flex-col gap-2";
const HINT = "text-[12px] text-dim-foreground";

/** How long typing pauses before the form asks where the project would go. */
const CHECK_DELAY_MS = 250;

function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const { projects } = useDesktop();
  const [form, setForm] = useState<NewProjectForm>(() => ({
    name: "",
    parent: defaultLocation(projects),
    folderEdit: null,
    useParent: false,
  }));
  const [check, setCheck] = useState<NewProjectCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = useMemo(() => draftOf(form), [form]);

  useEffect(() => {
    if (!draft?.name.trim()) {
      setCheck(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      bridge.checkNewProject(draft).then(
        (result) => live && setCheck(result),
        (e: unknown) =>
          live &&
          setCheck({ path: "", creates: false, error: e instanceof Error ? e.message : String(e) }),
      );
    }, CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft]);

  const set = (patch: Partial<NewProjectForm>): void => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const browse = async (): Promise<void> => {
    const picked = await bridge.pickFolder();
    if (picked) set({ parent: picked });
  };
  const ready = !!draft && !!check && !check.error && check.path !== "" && !busy;
  const submit = async (): Promise<void> => {
    if (!draft || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const project = await bridge.createProject(draft);
      onDone();
      window.location.hash = projectHref(project.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Create project</DialogTitle>
        <DialogDescription>
          BAKED makes the folder, writes <span className="font-mono">baked/project.json</span> with
          the name and opens the project. To use a folder that already has files, choose Open
          existing folder instead.
        </DialogDescription>
      </DialogHeader>
      <div className={FIELD}>
        <Label htmlFor="new-project-name">Name</Label>
        <Input
          id="new-project-name"
          value={form.name}
          placeholder="My new app"
          disabled={busy}
          autoFocus
          onChange={(event) => set({ name: event.target.value })}
        />
      </div>
      <div className={FIELD}>
        <Label htmlFor="new-project-location">Location</Label>
        <div className="flex gap-2">
          <Input
            id="new-project-location"
            className="min-w-0 flex-1 font-mono"
            value={form.parent ?? ""}
            placeholder="Choose a folder"
            readOnly
          />
          <Button type="button" variant="secondary" size="md" disabled={busy} onClick={browse}>
            Browse…
          </Button>
        </div>
        <span className="flex items-center gap-2.5">
          <Switch
            checked={form.useParent}
            disabled={busy}
            onCheckedChange={(on) => set({ useParent: on })}
            aria-label="Use the chosen folder itself"
          />
          <span aria-hidden="true">Use the chosen folder itself (it must be empty)</span>
        </span>
      </div>
      {!form.useParent && (
        <div className={FIELD}>
          <Label htmlFor="new-project-folder">Folder name</Label>
          <Input
            id="new-project-folder"
            className="font-mono"
            value={folderOf(form)}
            disabled={busy}
            onChange={(event) => set({ folderEdit: event.target.value })}
          />
        </div>
      )}
      <p className={HINT} aria-live="polite">
        {!form.parent
          ? "Choose where the project goes."
          : check?.path
            ? `${check.creates ? "Creates" : "Uses"} ${check.path}`
            : " "}
      </p>
      {check?.error && form.name.trim() && (
        <span className="text-[12px] text-[var(--err)]" role="status">
          {check.error}
        </span>
      )}
      {error && (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="md" disabled={!ready}>
          {busy ? "Creating…" : "Create"}
        </Button>
        <Button type="button" variant="secondary" size="md" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The Create project dialog; the form starts fresh each time it opens. */
export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(560px,calc(100vw-48px))]">
        {open && <CreateProjectForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
