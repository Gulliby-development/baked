import { type FormEvent, useEffect, useState } from "react";
import { bridge } from "../client/bridge.js";
import { errorText } from "../client/runs.js";
import { type PackageKind, sddExport, type WrittenPackage } from "../client/sdd-export.js";
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
import { Segment, SegmentGroup } from "./ui/segmented.js";

/** Where a package goes unless the person types another path: `.baked/exports/ID-export`. */
export const defaultPackageOut = (id: string, zip: boolean): string =>
  `.baked/exports/${id}-export${zip ? ".zip" : ""}`;

/**
 * Why a destination cannot be used, or null: the server writes only inside the project, so the
 * path is relative to it and stays in it.
 */
export function packageOutProblem(out: string): string | null {
  const path = out.trim().replaceAll("\\", "/");
  if (!path) return "Name a path in the project.";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    return "Use a path relative to the project folder.";
  if (path.split("/").includes("..")) return "The package stays inside the project folder.";
  return null;
}

/** The result line: what the package holds and where it went. */
export function packageSummary(written: WrittenPackage): string {
  const features = written.manifest.features;
  const accepted = features.filter((f) => f.accepted).length;
  return `${written.zip ? "Archive" : "Folder"} with ${written.files.length} files, ${accepted} of ${features.length} feature${features.length === 1 ? "" : "s"} accepted`;
}

/**
 * Export package… on the run and initiative screens (#2207): the accepted spec, plan, tasks and
 * graph as a folder or one zip archive inside the project, for another coding agent to read.
 */
export function ExportPackageDialog({
  open,
  projectKey,
  kind,
  id,
  onClose,
}: {
  open: boolean;
  projectKey: string;
  kind: PackageKind;
  id: string;
  onClose: () => void;
}) {
  const [zip, setZip] = useState(false);
  const [out, setOut] = useState(defaultPackageOut(id, false));
  // The path stays the default while the person has not typed one, so the toggle can follow it.
  const [typed, setTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<WrittenPackage | null>(null);

  useEffect(() => {
    if (!open) return;
    setZip(false);
    setOut(defaultPackageOut(id, false));
    setTyped(false);
    setError(null);
    setWritten(null);
  }, [open, id]);

  const pick = (next: boolean) => {
    setZip(next);
    if (!typed) setOut(defaultPackageOut(id, next));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = packageOutProblem(out);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setWritten(
        await sddExport.write(projectKey, kind, id, {
          zip,
          out: out.trim().replaceAll("\\", "/"),
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export package</DialogTitle>
          <DialogDescription>
            The accepted spec, plan, tasks and graph of this {kind} as plain Markdown and JSON, with
            an AGENTS.md that tells another coding agent how to read them. Drafts, logs and model
            calls stay out.
          </DialogDescription>
        </DialogHeader>
        {written ? (
          <div className="flex flex-col gap-3">
            <Alert tone="info">{packageSummary(written)}</Alert>
            <span className="break-all text-[13px]" data-testid="package-path">
              {written.path}
            </span>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={() =>
                  void bridge.showInFolder(projectKey, written.path).catch((err: unknown) => {
                    setError(errorText(err));
                  })
                }
              >
                Show in folder
              </Button>
              <Button type="button" variant="primary" size="md" onClick={onClose}>
                Done
              </Button>
            </div>
            {error && <Alert tone="error">{error}</Alert>}
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
            <SegmentGroup aria-label="Format" className="flex flex-col gap-1">
              <legend className="mb-1 text-[13px] font-semibold">Format</legend>
              <div className="flex flex-wrap">
                <Segment aria-pressed={!zip} disabled={busy} onClick={() => pick(false)}>
                  Folder
                </Segment>
                <Segment aria-pressed={zip} disabled={busy} onClick={() => pick(true)}>
                  Zip archive
                </Segment>
              </div>
            </SegmentGroup>
            <div className="flex flex-col gap-1">
              <Label htmlFor="package-out">Destination in the project</Label>
              <Input
                id="package-out"
                value={out}
                disabled={busy}
                spellCheck={false}
                onChange={(e) => {
                  setOut(e.target.value);
                  setTyped(true);
                }}
              />
            </div>
            {error && <Alert tone="error">{error}</Alert>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" size="md" disabled={busy} onClick={onClose}>
                Keep
              </Button>
              <Button type="submit" variant="primary" size="md" disabled={busy}>
                {busy ? "Exporting…" : "Export"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
