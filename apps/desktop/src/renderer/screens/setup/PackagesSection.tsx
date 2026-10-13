import { useState } from "react";
import { bridge } from "../../client/bridge.js";
import {
  FILE_STATUS,
  type InstalledPackage,
  type InstallResult,
  installAction,
  type PackageKind,
  type PackagePlan,
  packages,
} from "../../client/packages.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import {
  ACTIONS,
  ADD,
  errorText,
  GROW,
  LINE,
  LIST,
  LoadState,
  NOTE,
  SETUP,
  STACK,
  Tag,
  useLoad,
  WARN,
  WRAP,
} from "./shared.js";

const KIND_LABEL: Record<PackageKind, string> = {
  agents: "Agent profiles",
  skills: "Skills",
  workflows: "Workflows",
  gates: "Gates",
};

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

function Plan({
  plan,
  busy,
  onInstall,
}: {
  plan: PackagePlan;
  busy: boolean;
  onInstall: (overwrite: boolean) => void;
}) {
  const action = installAction(plan);
  const kinds = (Object.keys(KIND_LABEL) as PackageKind[]).filter((k) => plan.contents[k].length);
  return (
    <section aria-label={`Plan for ${plan.name}`} className={cn(PANEL, STACK)}>
      <div className={STACK}>
        <h2 className="m-0 text-[15px] font-semibold">
          {plan.name} {plan.version}
          {plan.installed && (
            <span className={cn("ml-2 font-normal text-dim-foreground", NOTE)}>
              installed: {plan.installed}
            </span>
          )}
        </h2>
        {plan.description && <p className={LEDE}>{plan.description}</p>}
        <span className={cn("font-mono text-dim-foreground", NOTE, WRAP)}>{plan.source}</span>
      </div>
      {kinds.length > 0 && (
        <ul className={cn(LIST, "flex flex-wrap gap-x-4 gap-y-1")}>
          {kinds.map((k) => (
            <li key={k} className={NOTE}>
              <span className="text-dim-foreground">{KIND_LABEL[k]}:</span>{" "}
              <span className="font-mono">{plan.contents[k].join(", ")}</span>
            </li>
          ))}
        </ul>
      )}
      <ul className={cn(LIST, "rounded-base border-2 border-border")} aria-label="Files">
        {plan.files.map((f) => (
          <li key={f.target} className={LINE}>
            <span className={cn(GROW, "font-mono", WRAP)}>{f.target}</span>
            <Tag tone={f.status === "overwrite" ? "warn" : undefined}>{FILE_STATUS[f.status]}</Tag>
          </li>
        ))}
      </ul>
      {plan.stale.some((s) => s.action !== "missing") && (
        <ul className={cn(LIST, NOTE)} aria-label="Files of the installed version">
          {plan.stale
            .filter((s) => s.action !== "missing")
            .map((s) => (
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
        <p className={cn(NOTE, WARN)}>
          Gates {plan.gatesToConfirm.join(", ")} need confirming in Gates and checks before a run
          uses them; installing does not confirm them.
        </p>
      )}
      {plan.problems.length > 0 && (
        <Alert tone="error">
          <span className="block">This package cannot be installed:</span>
          <ul className="m-0 pl-4">
            {plan.problems.map((p) => (
              <li key={p} className={WRAP}>
                {p}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <div className={ACTIONS}>
        <Button
          variant="primary"
          size="md"
          disabled={busy || !action.allowed}
          onClick={() => onInstall(plan.overwrites > 0)}
        >
          {action.label}
        </Button>
      </div>
    </section>
  );
}

function Installed({
  item,
  busy,
  onRemove,
}: {
  item: InstalledPackage;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <li className={LINE}>
      <span className={cn(GROW, STACK, "gap-1")}>
        <span className="font-semibold">
          {item.name} <span className="font-mono font-normal">{item.version}</span>
        </span>
        <span className={cn("text-dim-foreground", NOTE, WRAP)}>
          {item.files.length} files · installed {item.installedAt.slice(0, 16).replace("T", " ")}
          {item.description ? ` · ${item.description}` : ""}
        </span>
      </span>
      {item.changed.length > 0 && <Tag tone="warn">{item.changed.length} edited</Tag>}
      <Button
        variant="secondary"
        size="md"
        disabled={busy}
        aria-label={`Remove ${item.name}`}
        onClick={onRemove}
      >
        Remove…
      </Button>
    </li>
  );
}

/**
 * BAKED packages: pick a local package folder, read what it would write into the project's
 * `baked/` folders, install it with an explicit button, and remove installed packages. The same
 * as `baked add` and `/packages` (docs/packages.md).
 */
export function PackagesSection({ project }: SectionProps) {
  const [list, refresh] = useLoad(() => packages.list(project.key), ["packages", project.key]);
  const [path, setPath] = useState("");
  const [plan, setPlan] = useState<PackagePlan | null>(null);
  const [removing, setRemoving] = useState<InstalledPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const inspect = (folder: string) =>
    act(async () => {
      setPlan(null);
      setPlan(await packages.inspect(project.key, folder.trim()));
    });
  const browse = async (): Promise<void> => {
    const picked = await bridge.pickFolder();
    if (!picked) return;
    setPath(picked);
    await inspect(picked);
  };

  if (list.state !== "ready") return <LoadState value={list} what="packages" />;
  const items = list.data.packages;
  return (
    <div className={SETUP}>
      <p className={LEDE}>
        A package is a local folder with a <span className="font-mono">baked-package.json</span>{" "}
        that lists agent profiles, skills, workflows and gates with their SHA-256 hashes. Installing
        checks every hash and definition, then copies the files into this project's{" "}
        <span className="font-mono">baked/</span> folders, where they are ordinary project files.
        Nothing is loaded from the package folder afterwards.
      </p>
      <section aria-label="Install a package" className={STACK}>
        <h2 className={LABEL}>Install a package</h2>
        <form
          className={ADD}
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void inspect(path);
          }}
        >
          <Input
            aria-label="Package folder"
            placeholder="Package folder"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button
            type="button"
            variant="secondary"
            size="md"
            disabled={busy}
            onClick={() => void browse()}
          >
            Choose folder…
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={busy || !path.trim()}>
            Show plan
          </Button>
        </form>
      </section>
      {error && <Alert tone="error">{error}</Alert>}
      {note && (
        <p role="status" className={NOTE}>
          {note}
        </p>
      )}
      {plan && (
        <Plan
          plan={plan}
          busy={busy}
          onInstall={(overwrite) =>
            void act(async () => {
              const result = await packages.install(project.key, plan, overwrite);
              setPlan(null);
              setNote(
                `${installSummary(result)}${result.gatesToConfirm.length ? ` Confirm gates ${result.gatesToConfirm.join(", ")} in Gates and checks before a run uses them.` : ""}`,
              );
              refresh();
            })
          }
        />
      )}
      <section aria-label="Installed packages" className={STACK}>
        <h2 className={LABEL}>Installed</h2>
        {items.length === 0 ? (
          <Empty>No packages installed in this project.</Empty>
        ) : (
          <ul className={cn(PANEL, LIST, "p-0")}>
            {items.map((item) => (
              <Installed
                key={item.name}
                item={item}
                busy={busy}
                onRemove={() => setRemoving(item)}
              />
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? ""}?`}
        confirmLabel="Remove"
        danger
        busy={busy}
        error={error}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          void act(async () => {
            if (!removing) return;
            const result = await packages.remove(project.key, removing.name);
            setRemoving(null);
            setNote(
              `Removed ${result.name} ${result.version}: ${result.removed.length} files deleted${result.kept.length ? `; kept ${result.kept.length} edited: ${result.kept.join(", ")}` : ""}.`,
            );
            refresh();
          })
        }
      >
        Files unchanged since the install are deleted from <span className="font-mono">baked/</span>
        . Files edited since stay in the project.
      </ConfirmDialog>
    </div>
  );
}
