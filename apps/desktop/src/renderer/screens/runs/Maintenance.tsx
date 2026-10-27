import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { formatBytes as bytes } from "../../client/diagnostics.js";
import {
  type ArtifactEntry,
  errorText,
  type GcResult,
  type ImportResult,
  type ImportSource,
  RUN_MAINTENANCE_CAPABILITY,
  runMaintenance,
  runs,
  WORKTREES_CAPABILITY,
  type WorktreeCleanup,
  type WorktreeReport,
} from "../../client/runs.js";
import {
  type ImportedPackage,
  importedSummary,
  SDD_EXPORT_CAPABILITY,
  SDD_IMPORT_CAPABILITY,
  sddImport,
} from "../../client/sdd-export.js";
import { ExportPackageDialog } from "../../components/ExportPackageDialog.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { fieldClass, Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Textarea } from "../../components/ui/textarea.js";
import { cn } from "../../lib/cn.js";
import type { RunData } from "./load.js";

/** Artifacts a redaction can target: content, not run state or an earlier redaction's tombstone. */
export function redactable(artifacts: ArtifactEntry[]): ArtifactEntry[] {
  const redacted = new Set(
    artifacts
      .filter((a) => a.kind === "redaction")
      .map((a) => a.path.replace(/^redactions\//, "").replace(/\.json$/, "")),
  );
  return artifacts.filter(
    (a) => a.kind !== "state" && a.kind !== "redaction" && !redacted.has(a.id),
  );
}

/**
 * How old an ended run must be for cleanup, in days: picked from these instead of a date field,
 * whose calendar is the platform's. The server keeps runs of the last 30 days anyway.
 */
export const CLEANUP_AGES = [
  { days: 30, label: "30 days ago" },
  { days: 90, label: "90 days ago" },
  { days: 182, label: "6 months ago" },
  { days: 365, label: "a year ago" },
] as const;

/** The cleanup cutoff for an age: the start of the local day that many days ago, as ISO. */
export function cleanupCutoff(days: number, now = Date.now()): string {
  const day = new Date(now - days * 86_400_000);
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
}

const FIELD = "flex flex-col gap-1";

function FormDialog({
  open,
  title,
  description,
  children,
  error,
  busy,
  submitLabel,
  danger = false,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  children: ReactNode;
  error: string | null;
  busy: boolean;
  submitLabel: string | null;
  danger?: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          {children}
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" size="md" disabled={busy} onClick={onClose}>
              {submitLabel ? "Keep" : "Done"}
            </Button>
            {submitLabel && (
              <Button
                type="submit"
                variant={danger ? "danger" : "primary"}
                size="md"
                disabled={busy}
              >
                {submitLabel}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Export report, Export package… and Redact on the run screen, as `baked workflow export`,
 * `export-package` and `redact` do. Export report writes the diagnostic manifest into a new folder
 * under `.baked/exports/`; Export package… writes the accepted spec, plan and tasks as an SDD package.
 */
export function RunMaintenance({ projectKey, data }: { projectKey: string; data: RunData }) {
  const runId = data.status.runId;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; failed?: boolean } | null>(null);
  const [redacting, setRedacting] = useState(false);
  const [packaging, setPackaging] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactEntry[] | null>(null);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!redacting) return;
    let live = true;
    setArtifacts(null);
    runs.artifacts(projectKey, runId).then(
      (all) => {
        if (!live) return;
        const list = redactable(all);
        setArtifacts(list);
        setTarget((t) => t || list[0]?.id || "");
      },
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [redacting, projectKey, runId]);

  if (!data.capabilities.includes(RUN_MAINTENANCE_CAPABILITY)) return null;
  // The SDD export package holds accepted work only, so it is offered once the plan is approved.
  const canPackage =
    data.capabilities.includes(SDD_EXPORT_CAPABILITY) && !!data.status.approvalDigest;

  const exportRun = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await runMaintenance.exportRun(projectKey, runId);
      setNotice({ text: `Exported to ${result.path}` });
    } catch (e) {
      setNotice({ text: errorText(e), failed: true });
    } finally {
      setBusy(false);
    }
  };
  const redact = async () => {
    if (!reason.trim()) {
      setError("Say why the content is removed.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await runMaintenance.redact(projectKey, runId, target, reason.trim());
      const path = artifacts?.find((a) => a.id === target)?.path ?? target;
      setRedacting(false);
      setReason("");
      setTarget("");
      setNotice({ text: `Redacted ${path}. Evidence built on it is no longer valid.` });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {notice && (
        <span
          role={notice.failed ? "alert" : "status"}
          className={cn(
            "max-w-[420px] break-all text-[12px]",
            notice.failed ? "text-[var(--err)]" : "text-dim-foreground",
          )}
        >
          {notice.text}
        </span>
      )}
      <Button
        variant="secondary"
        size="md"
        disabled={busy}
        title="The run's diagnostic report (manifest.json) to attach to a bug report"
        onClick={() => void exportRun()}
      >
        Export report
      </Button>
      {canPackage && (
        <Button variant="secondary" size="md" disabled={busy} onClick={() => setPackaging(true)}>
          Export package…
        </Button>
      )}
      <ExportPackageDialog
        open={packaging}
        projectKey={projectKey}
        kind="run"
        id={runId}
        onClose={() => setPackaging(false)}
      />
      <Button
        variant="secondary"
        size="md"
        disabled={busy}
        onClick={() => {
          setError(null);
          setRedacting(true);
        }}
      >
        Redact…
      </Button>
      <FormDialog
        open={redacting}
        title="Redact an artifact?"
        description="Replaces the artifact's content with a tombstone and keeps its hash, so reads fail integrity checks and evidence built on it is no longer valid. Copies in other artifacts stay."
        error={error}
        busy={busy}
        danger
        submitLabel={artifacts?.length ? "Redact" : null}
        onSubmit={() => void redact()}
        onClose={() => setRedacting(false)}
      >
        {artifacts === null && !error && <span className="text-[13px]">Loading artifacts…</span>}
        {artifacts?.length === 0 && (
          <span className="text-[13px]">This run has no content left to redact.</span>
        )}
        {artifacts && artifacts.length > 0 && (
          <>
            <div className={FIELD}>
              <Label htmlFor="redact-artifact">Artifact</Label>
              <select
                id="redact-artifact"
                className={cn(fieldClass, "h-10")}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {artifacts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.path} ({a.kind}, {bytes(a.bytes)})
                  </option>
                ))}
              </select>
            </div>
            <div className={FIELD}>
              <Label htmlFor="redact-reason">Reason</Label>
              <Textarea
                id="redact-reason"
                rows={2}
                value={reason}
                placeholder="Remove a pasted API key"
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </>
        )}
      </FormDialog>
    </>
  );
}

type Open = "gc" | "import" | "worktrees" | null;
/** `baked-export` reads back a package of Export package… (#2208); the others make a candidate. */
type Source = ImportSource | "baked-export";
const SOURCES: { value: Source; label: string }[] = [
  { value: "spec-kit", label: "Spec Kit (spec.md, spec.json, tasks.json, plan.md)" },
  { value: "ecc", label: "ECC agents" },
  { value: "markdown-edit", label: "Markdown folder" },
  { value: "baked-export", label: "BAKED export package (folder or .zip)" },
];

/**
 * Clean up old runs and Import on the run list, as `baked workflow gc` and `import` do. Cleanup
 * shows what it would remove before it removes anything.
 */
export function RunsMaintenance({
  projectKey,
  onChanged,
}: {
  projectKey: string;
  onChanged: () => void;
}) {
  const [offered, setOffered] = useState(false);
  const [worktreesOffered, setWorktreesOffered] = useState(false);
  const [usage, setUsage] = useState<WorktreeReport | null>(null);
  const [cleaned, setCleaned] = useState<WorktreeCleanup | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [age, setAge] = useState(90);
  const [preview, setPreview] = useState<GcResult | null>(null);
  const [removed, setRemoved] = useState<GcResult | null>(null);
  const [packagesOffered, setPackagesOffered] = useState(false);
  const [source, setSource] = useState<Source>("spec-kit");
  const [path, setPath] = useState("");
  const [featureId, setFeatureId] = useState("");
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [importedPackage, setImportedPackage] = useState<ImportedPackage | null>(null);

  useEffect(() => {
    let live = true;
    runs.capabilities(projectKey).then(
      (caps) => {
        if (!live) return;
        setOffered(caps.includes(RUN_MAINTENANCE_CAPABILITY));
        setWorktreesOffered(caps.includes(WORKTREES_CAPABILITY));
        setPackagesOffered(caps.includes(SDD_IMPORT_CAPABILITY));
      },
      () => live && setOffered(false),
    );
    return () => {
      live = false;
    };
  }, [projectKey]);

  if (!offered) return null;

  const show = (which: Open) => {
    setError(null);
    setPreview(null);
    setRemoved(null);
    setImported(null);
    setImportedPackage(null);
    setUsage(null);
    setCleaned(null);
    setOpen(which);
    if (which === "worktrees")
      void run(async () => setUsage(await runMaintenance.worktrees(projectKey)));
  };
  const run = async (work: () => Promise<void>) => {
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
  const cutoff = () => cleanupCutoff(age);
  const gcSubmit = () =>
    void run(async () => {
      if (!preview) {
        setPreview(await runMaintenance.gc(projectKey, cutoff(), true));
        return;
      }
      setRemoved(await runMaintenance.gc(projectKey, cutoff(), false));
      setPreview(null);
      onChanged();
    });
  const removable = usage?.worktrees.filter((w) => w.removable) ?? [];
  const worktreesSubmit = () =>
    void run(async () => {
      setCleaned(await runMaintenance.cleanWorktrees(projectKey, false));
      setUsage(await runMaintenance.worktrees(projectKey));
    });
  const packageSource = source === "baked-export";
  const done = imported !== null || importedPackage !== null;
  const importSubmit = () =>
    void run(async () => {
      if (packageSource) {
        if (!path.trim()) {
          setError("Name the package folder or .zip archive.");
          return;
        }
        setImportedPackage(
          await sddImport.importPackage(projectKey, {
            path: path.trim(),
            ...(featureId.trim() ? { id: featureId.trim() } : {}),
          }),
        );
        onChanged();
        return;
      }
      if (!path.trim() || !featureId.trim()) {
        setError("Name the folder and the feature ID.");
        return;
      }
      setImported(
        await runMaintenance.importCandidate(projectKey, {
          source: source as ImportSource,
          path: path.trim(),
          featureId: featureId.trim(),
        }),
      );
    });

  return (
    <div className="ml-auto flex flex-wrap gap-2">
      <Button variant="secondary" size="md" onClick={() => show("import")}>
        Import…
      </Button>
      {worktreesOffered && (
        <Button variant="secondary" size="md" onClick={() => show("worktrees")}>
          Worktrees…
        </Button>
      )}
      <Button variant="secondary" size="md" onClick={() => show("gc")}>
        Clean up old runs…
      </Button>
      <FormDialog
        open={open === "worktrees"}
        title="Run worktrees"
        description="Worktrees under .baked/worktrees with their size and run. Cleanup removes those of completed, failed, cancelled and unknown runs; the run branches stay."
        error={error}
        busy={busy}
        danger
        submitLabel={
          removable.length > 0
            ? `Remove ${removable.length} worktree${removable.length === 1 ? "" : "s"} (${bytes(
                removable.reduce((sum, w) => sum + w.bytes, 0) + (usage?.trashBytes ?? 0),
              )})`
            : null
        }
        onSubmit={worktreesSubmit}
        onClose={() => setOpen(null)}
      >
        {usage && usage.worktrees.length === 0 && (
          <span role="status" className="text-[13px]">
            No run worktrees on disk.
          </span>
        )}
        {usage && usage.worktrees.length > 0 && (
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-[13px]">
            {usage.worktrees.map((w) => (
              <li key={w.runId} className="flex justify-between gap-3">
                <span className="truncate">
                  {w.featureId ?? w.runId.slice(0, 8)} · {w.status}
                  {w.worktrees.length > 1 ? ` · ${w.worktrees.length} worktrees` : ""}
                  {w.kept ? ` · kept: ${w.kept}` : ""}
                </span>
                <span className="shrink-0 tabular-nums">{bytes(w.bytes)}</span>
              </li>
            ))}
          </ul>
        )}
        {cleaned && (
          <span role="status" className="text-[13px]">
            Removed {cleaned.runIds.length} worktree{cleaned.runIds.length === 1 ? "" : "s"} (
            {bytes(cleaned.bytes)}).
            {cleaned.warnings.length > 0 ? ` Left on disk: ${cleaned.warnings.join("; ")}` : ""}
          </span>
        )}
      </FormDialog>
      <FormDialog
        open={open === "gc"}
        title="Clean up old runs"
        description="Removes completed, failed and cancelled runs last changed longer ago than you pick, with their artifacts. Runs a child run, an initiative or a lease still needs are kept."
        error={error}
        busy={busy}
        danger={preview !== null && preview.runIds.length > 0}
        submitLabel={
          removed
            ? null
            : preview === null
              ? "Preview"
              : preview.runIds.length > 0
                ? `Remove ${preview.runIds.length} run${preview.runIds.length === 1 ? "" : "s"}`
                : null
        }
        onSubmit={gcSubmit}
        onClose={() => setOpen(null)}
      >
        <SegmentGroup aria-label="Last changed before" className={FIELD}>
          <legend className="mb-1 text-[13px] font-semibold">Last changed before</legend>
          <div className="flex flex-wrap">
            {CLEANUP_AGES.map(({ days, label }) => (
              <Segment
                key={days}
                aria-pressed={age === days}
                disabled={busy || removed !== null}
                onClick={() => {
                  setAge(days);
                  setPreview(null);
                }}
              >
                {label}
              </Segment>
            ))}
          </div>
        </SegmentGroup>
        {preview && (
          <span role="status" className="text-[13px]">
            {preview.runIds.length === 0
              ? "Nothing to clean up: no ended run is that old."
              : `${preview.runIds.length} run${preview.runIds.length === 1 ? "" : "s"} (${bytes(preview.bytes)} of artifacts): ${preview.runIds.join(", ")}`}
          </span>
        )}
        {removed && (
          <span role="status" className="text-[13px]">
            Removed {removed.runIds.length} run{removed.runIds.length === 1 ? "" : "s"} (
            {bytes(removed.bytes)}).
          </span>
        )}
      </FormDialog>
      <FormDialog
        open={open === "import"}
        title={packageSource ? "Import an export package" : "Import a spec or agents"}
        description={
          packageSource
            ? "Continues the work of a package written by Export package…: its manifest is checked, an initiative waits for the approval of its split (a run is created, not started), and each feature with an accepted spec starts at analysis with it."
            : "Reads a local folder into an inert candidate under .baked/workflow-imports. Nothing runs and no agent is enabled; pass an accepted spec, plan and tasks to a run as a candidate. Needs workflows.importsEnabled."
        }
        error={error}
        busy={busy}
        submitLabel={done ? null : "Import"}
        onSubmit={importSubmit}
        onClose={() => setOpen(null)}
      >
        <div className={FIELD}>
          <Label htmlFor="import-source">Source</Label>
          <select
            id="import-source"
            className={cn(fieldClass, "h-10")}
            value={source}
            disabled={done}
            onChange={(e) => setSource(e.target.value as Source)}
          >
            {SOURCES.filter((s) => packagesOffered || s.value !== "baked-export").map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className={FIELD}>
          <Label htmlFor="import-path">{packageSource ? "Folder or .zip archive" : "Folder"}</Label>
          <Input
            id="import-path"
            value={path}
            placeholder={packageSource ? "handoff/shop-export.zip" : "specs/feature"}
            disabled={done}
            onChange={(e) => setPath(e.target.value)}
          />
        </div>
        <div className={FIELD}>
          <Label htmlFor="import-feature">
            {packageSource ? "New ID (optional, the package's by default)" : "Feature ID"}
          </Label>
          <Input
            id="import-feature"
            value={featureId}
            placeholder={packageSource ? "" : "imported-feature"}
            disabled={done}
            onChange={(e) => setFeatureId(e.target.value)}
          />
        </div>
        {importedPackage && (
          <span role="status" className="text-[13px]">
            {importedSummary(importedPackage)}
          </span>
        )}
        {imported && (
          <div role="status" className="flex flex-col gap-1 text-[13px]">
            <span>
              Imported as candidate{" "}
              <span className="font-mono">{imported.candidateHash.slice(0, 12)}</span>.
            </span>
            {[...imported.warnings, ...imported.unsupported].map((w) => (
              <span key={w} className="text-[var(--warn)]">
                {w}
              </span>
            ))}
          </div>
        )}
      </FormDialog>
    </div>
  );
}
