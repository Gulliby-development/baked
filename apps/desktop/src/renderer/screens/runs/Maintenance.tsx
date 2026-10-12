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
} from "../../client/runs.js";
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

/** The default cleanup cutoff: 90 days ago, as an ISO date for the date field. */
export function defaultCutoff(now = Date.now()): string {
  return new Date(now - 90 * 86_400_000).toISOString().slice(0, 10);
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
 * Export and Redact on the run screen, as `baked workflow export` and `redact` do. Export writes
 * the portable manifest into a new folder under `.baked/exports/`.
 */
export function RunMaintenance({ projectKey, data }: { projectKey: string; data: RunData }) {
  const runId = data.status.runId;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; failed?: boolean } | null>(null);
  const [redacting, setRedacting] = useState(false);
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
      <Button variant="secondary" size="md" disabled={busy} onClick={() => void exportRun()}>
        Export
      </Button>
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

type Open = "gc" | "import" | null;
const SOURCES: { value: ImportSource; label: string }[] = [
  { value: "spec-kit", label: "Spec Kit (spec.md, spec.json, tasks.json, plan.md)" },
  { value: "ecc", label: "ECC agents" },
  { value: "markdown-edit", label: "Markdown folder" },
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
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [before, setBefore] = useState(defaultCutoff);
  const [preview, setPreview] = useState<GcResult | null>(null);
  const [removed, setRemoved] = useState<GcResult | null>(null);
  const [source, setSource] = useState<ImportSource>("spec-kit");
  const [path, setPath] = useState("");
  const [featureId, setFeatureId] = useState("");
  const [imported, setImported] = useState<ImportResult | null>(null);

  useEffect(() => {
    let live = true;
    runs.capabilities(projectKey).then(
      (caps) => live && setOffered(caps.includes(RUN_MAINTENANCE_CAPABILITY)),
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
    setOpen(which);
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
  const cutoff = () => new Date(`${before}T00:00:00`).toISOString();
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
  const importSubmit = () =>
    void run(async () => {
      if (!path.trim() || !featureId.trim()) {
        setError("Name the folder and the feature ID.");
        return;
      }
      setImported(
        await runMaintenance.importCandidate(projectKey, {
          source,
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
      <Button variant="secondary" size="md" onClick={() => show("gc")}>
        Clean up old runs…
      </Button>
      <FormDialog
        open={open === "gc"}
        title="Clean up old runs"
        description="Removes completed, failed and cancelled runs last changed before the date and at least 30 days ago, with their artifacts. Runs a child run, an initiative or a lease still needs are kept."
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
        <div className={FIELD}>
          <Label htmlFor="gc-before">Last changed before</Label>
          <Input
            id="gc-before"
            type="date"
            value={before}
            disabled={busy || removed !== null}
            onChange={(e) => {
              setBefore(e.target.value);
              setPreview(null);
            }}
          />
        </div>
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
        title="Import a spec or agents"
        description="Reads a local folder into an inert candidate under .baked/workflow-imports. Nothing runs and no agent is enabled; pass an accepted spec, plan and tasks to a run as a candidate. Needs workflows.importsEnabled."
        error={error}
        busy={busy}
        submitLabel={imported ? null : "Import"}
        onSubmit={importSubmit}
        onClose={() => setOpen(null)}
      >
        <div className={FIELD}>
          <Label htmlFor="import-source">Source</Label>
          <select
            id="import-source"
            className={cn(fieldClass, "h-10")}
            value={source}
            disabled={imported !== null}
            onChange={(e) => setSource(e.target.value as ImportSource)}
          >
            {SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className={FIELD}>
          <Label htmlFor="import-path">Folder</Label>
          <Input
            id="import-path"
            value={path}
            placeholder="specs/feature"
            disabled={imported !== null}
            onChange={(e) => setPath(e.target.value)}
          />
        </div>
        <div className={FIELD}>
          <Label htmlFor="import-feature">Feature ID</Label>
          <Input
            id="import-feature"
            value={featureId}
            placeholder="imported-feature"
            disabled={imported !== null}
            onChange={(e) => setFeatureId(e.target.value)}
          />
        </div>
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
