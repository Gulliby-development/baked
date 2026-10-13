import { useState } from "react";
import { type InstalledPackage, packages } from "../../client/packages.js";
import { Icon, type IconName } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { Hint } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import { CreatePackageDialog, InstallPackageDialog } from "./PackageDialogs.js";
import {
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
  WRAP,
} from "./shared.js";

export { installSummary } from "./PackageDialogs.js";

const ACTION =
  "group flex w-full cursor-pointer items-center gap-3.5 rounded-base border-2 border-border bg-background px-4 py-3.5 text-left [font:inherit] text-foreground shadow-shadow transition-transform duration-150 hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none";
const ACTION_ICON =
  "flex size-11 shrink-0 items-center justify-center rounded-base border-2 border-border shadow-sm-hard transition-transform duration-200 group-hover:-rotate-6 motion-reduce:transition-none";

/** The two things the screen does, as large buttons that open their dialogs. */
export function PackageActions({
  onInstall,
  onCreate,
}: {
  onInstall: () => void;
  onCreate: () => void;
}) {
  const card = (icon: IconName, tone: string, title: string, what: string, onClick: () => void) => (
    <button type="button" className={ACTION} onClick={onClick}>
      <span className={cn(ACTION_ICON, tone)}>
        <Icon name={icon} size={22} />
      </span>
      <span className={cn(STACK, "gap-0.5")}>
        <span className="text-[15px] font-bold">{title}</span>
        <span className="text-[12px] text-muted-foreground">{what}</span>
      </span>
    </button>
  );
  return (
    <div className="grid grid-cols-2 gap-3 [@media(max-width:720px)]:grid-cols-1">
      {card(
        "packages",
        "bg-main text-main-foreground",
        "Install package",
        "Bring agent profiles, skills, workflows and gates from a package folder.",
        onInstall,
      )}
      {card(
        "new",
        "bg-fill-info text-main-foreground",
        "Create package",
        "Pack a folder you made: BAKED checks it and writes its baked-package.json.",
        onCreate,
      )}
    </div>
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
    <li className={cn(LINE, "py-3")}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-base border-2 border-border bg-main text-main-foreground">
        <Icon name="packages" size={16} />
      </span>
      <span className={cn(GROW, STACK, "gap-1")}>
        <span className="font-semibold text-foreground">
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
 * BAKED packages: the installed ones, Install package (pick a folder, read the plan, install) and
 * Create package (write a folder's `baked-package.json`), each a dialog. The same as `baked add`,
 * `baked packages` and `/packages` (docs/packages.md).
 */
export function PackagesSection({ project }: SectionProps) {
  const [list, refresh] = useLoad(() => packages.list(project.key), ["packages", project.key]);
  const [dialog, setDialog] = useState<"install" | "create" | null>(null);
  const [removing, setRemoving] = useState<InstalledPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (list.state !== "ready") return <LoadState value={list} what="packages" />;
  const items = list.data.packages;
  return (
    <div className={SETUP}>
      <p className={LEDE}>
        Packages bring agent profiles, skills, workflows and gates into this project.
        <Hint label="packages">
          A package is a local folder with a <span className="font-mono">baked-package.json</span>{" "}
          that lists its files with their SHA-256 hashes. Installing checks every hash and
          definition, then copies the files into this project's{" "}
          <span className="font-mono">baked/</span> folders, where they are ordinary project files.
          Nothing is loaded from the package folder afterwards.
        </Hint>
      </p>
      <PackageActions onInstall={() => setDialog("install")} onCreate={() => setDialog("create")} />
      {note && (
        <p role="status" className={NOTE}>
          {note}
        </p>
      )}
      {error && removing === null && <Alert tone="error">{error}</Alert>}
      <section aria-label="Installed packages" className={STACK}>
        <h2 className={LABEL}>Installed{items.length ? ` · ${items.length}` : ""}</h2>
        {items.length === 0 ? (
          <Empty>No packages installed in this project yet.</Empty>
        ) : (
          <ul className={cn(PANEL, LIST, "p-0")}>
            {items.map((item) => (
              <Installed
                key={item.name}
                item={item}
                busy={busy}
                onRemove={() => {
                  setError(null);
                  setRemoving(item);
                }}
              />
            ))}
          </ul>
        )}
      </section>
      <InstallPackageDialog
        projectKey={project.key}
        open={dialog === "install"}
        onOpenChange={(open) => setDialog(open ? "install" : null)}
        onInstalled={() => {
          setNote(null);
          refresh();
        }}
      />
      <CreatePackageDialog
        projectKey={project.key}
        open={dialog === "create"}
        onOpenChange={(open) => setDialog(open ? "create" : null)}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? ""}?`}
        confirmLabel="Remove"
        danger
        busy={busy}
        error={error}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          setBusy(true);
          setError(null);
          packages
            .remove(project.key, removing.name)
            .then((result) => {
              setRemoving(null);
              setNote(
                `Removed ${result.name} ${result.version}: ${result.removed.length} files deleted${result.kept.length ? `; kept ${result.kept.length} edited: ${result.kept.join(", ")}` : ""}.`,
              );
              refresh();
            })
            .catch((e: unknown) => setError(errorText(e)))
            .finally(() => setBusy(false));
        }}
      >
        Files unchanged since the install are deleted from <span className="font-mono">baked/</span>
        . Files edited since stay in the project.
      </ConfirmDialog>
    </div>
  );
}
