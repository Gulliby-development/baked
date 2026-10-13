import { useState } from "react";
import { PERMISSION_MODES, type PermissionMode } from "../../client/chat.js";
import { Icon, type IconName } from "../../components/Icon.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { cn } from "../../lib/cn.js";
import { CHIP, MENU_ITEM_STACKED, MENU_LIST, MENU_NOTE, Popover } from "./Popover.js";

export const PERMISSION_LABELS: Record<
  PermissionMode,
  { name: string; detail: string; icon: IconName }
> = {
  manual: {
    name: "Manual",
    detail: "Every edit, command and git change waits for your Allow.",
    icon: "eye",
  },
  auto: {
    name: "Auto",
    detail:
      "Safe actions run. Destructive commands, sensitive files, writes outside the project and web access ask.",
    icon: "ok",
  },
  full: {
    name: "Full access",
    detail: "Runs everything without asking, destructive commands too.",
    icon: "warning",
  },
};

/** Remembered once confirmed, so the warning shows the first time only. */
const FULL_ACCESS_KEY = "baked.fullAccessConfirmed";

function fullAccessConfirmed(): boolean {
  try {
    return localStorage.getItem(FULL_ACCESS_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberFullAccess(): void {
  try {
    localStorage.setItem(FULL_ACCESS_KEY, "1");
  } catch {
    // Without storage the warning shows again next time, which is safe.
  }
}

const TONE: Record<PermissionMode, string> = {
  manual:
    "bg-fill-info text-main-foreground hover:bg-fill-info hover:text-main-foreground aria-expanded:bg-fill-info aria-expanded:text-main-foreground",
  auto: "",
  full: "bg-fill-err text-main-foreground hover:bg-fill-err hover:text-main-foreground aria-expanded:bg-fill-err aria-expanded:text-main-foreground",
};

/**
 * The composer's permission chip: Manual, Auto or Full access for this chat. Full access asks for
 * confirmation the first time.
 */
export function PermissionChip({
  permissions,
  onPermissions,
}: {
  permissions: PermissionMode;
  onPermissions: (permissions: PermissionMode) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const label = PERMISSION_LABELS[permissions];
  const choose = (next: PermissionMode): void => {
    if (next === "full" && permissions !== "full" && !fullAccessConfirmed()) setConfirming(true);
    else onPermissions(next);
  };
  return (
    <>
      <Popover
        label="Permissions"
        up
        className={cn(CHIP, "transition-[background-color,color] duration-200", TONE[permissions])}
        buttonLabel={`Permissions: ${label.name}`}
        button={
          <span
            key={permissions}
            className="inline-flex items-center gap-[6px] animate-chip-in motion-reduce:animate-none"
          >
            <Icon name={label.icon} size={13} />
            {label.name}
          </span>
        }
      >
        {(close) => (
          <div className={MENU_LIST}>
            {PERMISSION_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={MENU_ITEM_STACKED}
                aria-pressed={mode === permissions}
                onClick={() => {
                  close();
                  choose(mode);
                }}
              >
                <span className="inline-flex items-center gap-[6px]">
                  <Icon name={PERMISSION_LABELS[mode].icon} size={13} />
                  {PERMISSION_LABELS[mode].name}
                </span>
                <span className="text-dim-foreground">{PERMISSION_LABELS[mode].detail}</span>
              </button>
            ))}
            <p className={MENU_NOTE}>Applies from the next action of this chat.</p>
          </div>
        )}
      </Popover>
      <ConfirmDialog
        open={confirming}
        title="Give this chat full access?"
        confirmLabel="Allow everything"
        danger
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          rememberFullAccess();
          setConfirming(false);
          onPermissions("full");
        }}
      >
        Edits, shell and git commands, web access and writes outside the project run without asking,
        destructive commands such as rm -rf or a force push too. You can switch back to Manual or
        Auto at any time.
      </ConfirmDialog>
    </>
  );
}
