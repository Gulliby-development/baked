import { useState } from "react";
import { ApiError } from "../../client/api.js";
import { bridge } from "../../client/bridge.js";
import {
  FILE_STATUS,
  type InstallResult,
  installAction,
  type PackagePlan,
  type PackResult,
  packages,
  packSummary,
} from "../../client/packages.js";
import { Alert } from "../../components/ui/alert.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { cn } from "../../lib/cn.js";
import { projectHref } from "../../router.js";
import { type BoxPhase, PackageBox } from "./PackageBox.js";
import {
  type BoxItem,
  boxItems,
  CLOSE_MS,
  CREATE_STEPS,
  type CreateStep,
  contentsLine,
  INSTALL_STEPS,
  type InstallStep,
  packingMs,
  prefersReducedMotion,
  wait,
} from "./packages-model.js";
import {
  ACTIONS,
  ADD,
  errorText,
  FIELD_HALF,
  FL,
  GROW,
  LINE,
  LIST,
  NOTE,
  PAIR,
  STACK,
  Tag,
  WARN,
  WRAP,
} from "./shared.js";

/** What an install did, in one sentence. */
export function installSummary(result: InstallResult): string {
  const parts = [
    `Installed ${result.name} ${result.version}: ${result.written.length} files written`,
    result.unchanged.length ? `${result.unchanged.length} already identical` : "",
    result.removed.length ? `${result.removed.length} files of the old version removed` : "",
    result.kept.length ? `${result.kept.length} edited files of the old version kept` : "",
  ].filter(Boolean);
  return `${parts.join(", ")}.`;
}

function Steps({
  steps,
  current,
}: {
  steps: readonly { step: string; title: string }[];
  current: string;
}) {
  const at = steps.findIndex((s) => s.step === current);
  return (
    <ol className="m-0 flex list-none flex-wrap gap-2 p-0 text-[12px]" aria-label="Steps">
      {steps.map((s, i) => (
        <li
          key={s.step}
          aria-current={i === at ? "step" : undefined}
          className={cn(
            "rounded-base border-2 border-border px-2 py-0.5 transition-colors duration-200 motion-reduce:transition-none",
            i === at ? "bg-main text-main-foreground" : i < at ? "" : "text-dim-foreground",
          )}
        >
          {i + 1}. {s.title}
        </li>
      ))}
    </ol>
  );
}

/** The folder field with Choose folder…; Enter or a picked folder goes on. */
function FolderField({
  id,
  value,
  busy,
  onChange,
  onSubmit,
  hint,
}: {
  id: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: (folder: string) => void;
  hint: string;
}) {
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() && !busy) onSubmit(value);
      }}
    >
      <Label htmlFor={id}>Package folder</Label>
      <div className={ADD}>
        <Input
          id={id}
          className="font-mono"
          placeholder="C:\packages\acme-review"
          autoFocus
          value={value}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() =>
            void bridge.pickFolder().then((picked) => {
              if (!picked) return;
              onChange(picked);
              onSubmit(picked);
            })
          }
        >
          Choose folder…
        </Button>
      </div>
      <p className={cn(NOTE, "m-0 text-muted-foreground")}>{hint}</p>
      <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
    </form>
  );
}

function Problems({ title, problems }: { title: string; problems: string[] }) {
  if (!problems.length) return null;
  return (
    <Alert tone="error">
      <span className="block">{title}</span>
      <ul className="m-0 pl-4">
        {problems.map((p) => (
          <li key={p} className={WRAP}>
            {p}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/** What the plan writes, below the box: the package, its files and what blocks or needs care. */
function PlanDetails({ plan }: { plan: PackagePlan }) {
  const stale = plan.stale.filter((s) => s.action !== "missing");
  return (
    <section aria-label={`Plan for ${plan.name}`} className={STACK}>
      <div className="flex flex-col items-center gap-1 text-center">
        <h3 className="m-0 text-[16px] font-bold">
          {plan.name} <span className="font-mono font-normal">{plan.version}</span>
          {plan.installed && (
            <span className="ml-2 align-middle">
              <Tag>installed: {plan.installed}</Tag>
            </span>
          )}
        </h3>
        {plan.description && (
          <p className="m-0 text-[13px] text-muted-foreground">{plan.description}</p>
        )}
        <p className={cn(NOTE, "m-0 text-soft-foreground")}>{contentsLine(plan.contents)}</p>
      </div>
      <details className="group rounded-base border-2 border-border">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-[14px] py-2 text-[13px] font-semibold [&::-webkit-details-marker]:hidden">
          <span className="inline-block transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none">
            ›
          </span>
          {plan.files.length} {plan.files.length === 1 ? "file" : "files"} into{" "}
          <span className="font-mono">baked/</span>
          {plan.overwrites > 0 && (
            <span className="ml-auto">
              <Tag tone="warn">
                {plan.overwrites} {plan.overwrites === 1 ? "replaces" : "replace"} a different file
              </Tag>
            </span>
          )}
        </summary>
        <ul className={cn(LIST, "border-t-2 border-border")} aria-label="Files">
          {plan.files.map((f) => (
            <li key={f.target} className={LINE}>
              <span className={cn(GROW, "font-mono", WRAP)}>{f.target}</span>
              <Tag tone={f.status === "overwrite" ? "warn" : undefined}>
                {FILE_STATUS[f.status]}
              </Tag>
            </li>
          ))}
        </ul>
      </details>
      {stale.length > 0 && (
        <ul className={cn(LIST, NOTE)} aria-label="Files of the installed version">
          {stale.map((s) => (
            <li key={s.target}>
              <span className="font-mono">{s.target}</span>:{" "}
              {s.action === "remove"
                ? "removed, this version no longer ships it"
                : "kept, edited since the install"}
            </li>
          ))}
        </ul>
      )}
      {plan.gatesToConfirm.length > 0 && (
        <p className={cn(NOTE, WARN, "m-0")}>
          Gates {plan.gatesToConfirm.join(", ")} need confirming in Gates and checks before a run
          uses them; installing does not confirm them.
        </p>
      )}
      <Problems title="This package cannot be installed:" problems={plan.problems} />
    </section>
  );
}

function InstallFlow({
  projectKey,
  onInstalled,
  onDone,
}: {
  projectKey: string;
  onInstalled: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<InstallStep>("folder");
  const [path, setPath] = useState("");
  const [plan, setPlan] = useState<PackagePlan | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [phase, setPhase] = useState<BoxPhase>("open");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inspect = async (folder: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await packages.inspect(projectKey, folder.trim()));
      setStep("plan");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const install = async (current: PackagePlan): Promise<void> => {
    setBusy(true);
    setError(null);
    setPhase("packing");
    try {
      const [done] = await Promise.all([
        packages.install(projectKey, current, current.overwrites > 0),
        wait(packingMs(boxItems(current.contents).length, prefersReducedMotion())),
      ]);
      setResult(done);
      setPhase("closed");
      // The step's text changes only once the box is shut and labelled, so the dialog keeps still.
      await wait(prefersReducedMotion() ? 0 : CLOSE_MS);
      setStep("done");
      onInstalled();
    } catch (e) {
      setPhase("open");
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const items: BoxItem[] = plan && step !== "folder" ? boxItems(plan.contents) : [];
  const action = plan ? installAction(plan) : null;
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Install a package</DialogTitle>
        <DialogDescription>
          Pick a package folder, look at what it brings, then install. Its files are copied into
          this project's <span className="font-mono">baked/</span> folders.
        </DialogDescription>
      </DialogHeader>
      <Steps steps={INSTALL_STEPS} current={step} />
      <PackageBox
        items={items}
        phase={phase}
        label={result ? `${result.name} ${result.version}` : undefined}
      />

      {step === "folder" && (
        <FolderField
          id="package-install-folder"
          value={path}
          busy={busy}
          onChange={setPath}
          onSubmit={(folder) => void inspect(folder)}
          hint="A folder with a baked-package.json. Nothing is installed until you confirm the plan."
        />
      )}
      {step === "plan" && plan && <PlanDetails plan={plan} />}
      {step === "done" && result && (
        <div
          role="status"
          className="flex animate-rise flex-col items-center gap-2 text-center motion-reduce:animate-none"
        >
          <p className="m-0 text-[13px]">{installSummary(result)}</p>
          {result.gatesToConfirm.length > 0 && (
            <p className={cn(NOTE, WARN, "m-0")}>
              Confirm gates {result.gatesToConfirm.join(", ")} in Gates and checks before a run uses
              them.
            </p>
          )}
        </div>
      )}

      {error && (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      )}

      <div className={cn(ACTIONS, "justify-end")}>
        {step === "folder" && (
          <>
            <Button variant="secondary" size="md" disabled={busy} onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={busy || !path.trim()}
              onClick={() => void inspect(path)}
            >
              {busy ? "Reading…" : "Show plan"}
            </Button>
          </>
        )}
        {step === "plan" && plan && action && (
          <>
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => {
                setError(null);
                setStep("folder");
              }}
            >
              Back
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={busy || !action.allowed}
              onClick={() => void install(plan)}
            >
              {busy ? "Installing…" : action.label}
            </Button>
          </>
        )}
        {step === "done" && (
          <>
            {result && result.gatesToConfirm.length > 0 && (
              <a
                className={cn(buttonVariants({ variant: "secondary", size: "md" }))}
                href={projectHref(projectKey, "gates")}
              >
                Open Gates and checks
              </a>
            )}
            <Button variant="primary" size="md" onClick={onDone}>
              Done
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** A folder without a manifest yet: the check asks for a name and a version. */
const needsFields = (e: unknown): boolean => e instanceof ApiError && e.code === "INVALID_ARGUMENT";

function CreateFlow({ projectKey, onDone }: { projectKey: string; onDone: () => void }) {
  const [step, setStep] = useState<CreateStep>("folder");
  const [form, setForm] = useState({ path: "", name: "", version: "", description: "" });
  const [checked, setChecked] = useState<PackResult | null>(null);
  const [result, setResult] = useState<PackResult | null>(null);
  const [phase, setPhase] = useState<BoxPhase>("open");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set =
    (field: keyof typeof form) =>
    (e: { target: { value: string } }): void =>
      setForm((f) => ({ ...f, [field]: e.target.value }));
  const request = () => ({
    path: form.path.trim(),
    name: form.name.trim(),
    version: form.version.trim(),
    description: form.description.trim(),
  });

  const open = async (folder: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setChecked(null);
    try {
      const found = await packages.pack(projectKey, { path: folder.trim() }, true);
      setChecked(found);
      setForm((f) => ({
        ...f,
        name: found.name ?? "",
        version: found.version ?? "",
        description: found.description ?? "",
      }));
      setStep("details");
    } catch (e) {
      if (needsFields(e)) setStep("details");
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const check = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setChecked(await packages.pack(projectKey, request(), true));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const write = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const done = await packages.pack(projectKey, request(), false);
      setChecked(done);
      if (done.problems.length) return;
      setPhase("packing");
      await wait(packingMs(boxItems(done.contents).length, prefersReducedMotion()));
      setResult(done);
      setPhase("closed");
      // The step's text changes only once the box is shut and labelled, so the dialog keeps still.
      await wait(prefersReducedMotion() ? 0 : CLOSE_MS);
      setStep("done");
    } catch (e) {
      setPhase("open");
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const items = checked && step !== "folder" ? boxItems(checked.contents) : [];
  const ready = !busy && form.name.trim() !== "" && form.version.trim() !== "";
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Create a package</DialogTitle>
        <DialogDescription>
          For package authors: BAKED checks a folder of agent profiles, skills, workflows and gates
          the way an install would, then writes its{" "}
          <span className="font-mono">baked-package.json</span> with every file's SHA-256. Nothing
          is installed.
        </DialogDescription>
      </DialogHeader>
      <Steps steps={CREATE_STEPS} current={step} />
      <PackageBox
        items={items}
        phase={phase}
        label={result ? `${result.name ?? ""} ${result.version ?? ""}`.trim() : undefined}
      />

      {step === "folder" && (
        <FolderField
          id="package-create-folder"
          value={form.path}
          busy={busy}
          onChange={(path) => setForm((f) => ({ ...f, path }))}
          onSubmit={(folder) => void open(folder)}
          hint="The folder with agents/, skills/, workflows/ or gates/ inside."
        />
      )}
      {step === "details" && (
        <form
          className="flex flex-col gap-3"
          aria-label="Name and version"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void write();
          }}
        >
          <p className={cn(NOTE, "m-0 text-center text-soft-foreground")}>
            {checked
              ? `${contentsLine(checked.contents) || "No files yet"} · ${packSummary(checked, true)}`
              : "No baked-package.json yet: give the package a name and a version."}
          </p>
          <div className={PAIR}>
            <div className={FIELD_HALF}>
              <label htmlFor="pack-name">Name</label>
              <Input
                id="pack-name"
                className="font-mono"
                placeholder="acme-review"
                autoFocus
                value={form.name}
                onChange={set("name")}
                disabled={busy}
              />
            </div>
            <div className={FIELD_HALF}>
              <label htmlFor="pack-version">Version</label>
              <Input
                id="pack-version"
                className="font-mono"
                placeholder="1.0.0"
                value={form.version}
                onChange={set("version")}
                disabled={busy}
              />
            </div>
          </div>
          <div className={FL}>
            <label htmlFor="pack-description">Description (optional)</label>
            <Input
              id="pack-description"
              value={form.description}
              onChange={set("description")}
              disabled={busy}
            />
          </div>
          <Problems title="Fix these, then pack again:" problems={checked?.problems ?? []} />
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
      {step === "done" && result && (
        <p
          role="status"
          className="m-0 animate-rise text-center text-[13px] motion-reduce:animate-none"
        >
          {packSummary(result, false)}{" "}
          <span className={cn("block font-mono text-dim-foreground", NOTE, WRAP)}>
            {result.manifestPath}
          </span>
        </p>
      )}

      {error && (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      )}

      <div className={cn(ACTIONS, "justify-end")}>
        {step === "folder" && (
          <>
            <Button variant="secondary" size="md" disabled={busy} onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={busy || !form.path.trim()}
              onClick={() => void open(form.path)}
            >
              {busy ? "Reading…" : "Next"}
            </Button>
          </>
        )}
        {step === "details" && (
          <>
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => {
                setError(null);
                setStep("folder");
              }}
            >
              Back
            </Button>
            <Button variant="secondary" size="md" disabled={!ready} onClick={() => void check()}>
              Check
            </Button>
            <Button variant="primary" size="md" disabled={!ready} onClick={() => void write()}>
              {busy && phase === "packing" ? "Packing…" : "Pack it"}
            </Button>
          </>
        )}
        {step === "done" && (
          <Button variant="primary" size="md" onClick={onDone}>
            Done
          </Button>
        )}
      </div>
    </div>
  );
}

const WIDE = "w-[min(620px,calc(100vw-48px))]";

/** Install a package step by step; it starts fresh each time it opens. */
export function InstallPackageDialog({
  projectKey,
  open,
  onOpenChange,
  onInstalled,
}: {
  projectKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={WIDE}>
        {open && (
          <InstallFlow
            projectKey={projectKey}
            onInstalled={onInstalled}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Write a package's manifest (`baked packages pack`) step by step. */
export function CreatePackageDialog({
  projectKey,
  open,
  onOpenChange,
}: {
  projectKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={WIDE}>
        {open && <CreateFlow projectKey={projectKey} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
