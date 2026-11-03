import { useEffect, useId, useState } from "react";
import { bridge } from "../../client/bridge.js";
import { type ProviderAccount, type ProviderAccounts, setup } from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Dot } from "../../components/ui/dot.js";
import { Input } from "../../components/ui/input.js";
import { TonePanel } from "../../components/ui/tone.js";
import { cn } from "../../lib/cn.js";
import { STACK as COLUMN } from "../../lib/styles.js";
import {
  ACCOUNT_ID,
  accountIdFrom,
  accountState,
  activeLabel,
  projectName,
} from "./accounts-model.js";
import { errorText, GROW, LINE_LOOSE, LoadState, NOTE, Tag, useLoad } from "./shared.js";

const PROVIDERS = ["claude-code", "codex"] as const;
const LOGIN_POLL_MS = 1000;

/** Runs a change and reports its error, keeping the busy flag while it runs. */
function useAct(onDone: (view: ProviderAccounts) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<ProviderAccounts | undefined>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const view = await work();
      if (view) onDone(view);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, act };
}

function AccountRow({
  projectKey,
  view,
  account,
  onView,
  reload,
}: {
  projectKey: string;
  view: ProviderAccounts;
  account: ProviderAccount;
  onView: (view: ProviderAccounts) => void;
  reload: () => void;
}) {
  const { busy, error, act } = useAct(onView);
  const [removing, setRemoving] = useState(false);
  const running = account.login?.state === "running";
  const state = accountState(account);

  // A sign-in finishes in the browser; poll it until it ends, then read the list again.
  useEffect(() => {
    if (!running) return;
    let live = true;
    const timer = setInterval(() => {
      setup.login(projectKey, view.provider, account.id).then(
        ({ login }) => {
          if (live && login?.state !== "running") reload();
        },
        () => live && reload(),
      );
    }, LOGIN_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running, projectKey, view.provider, account.id, reload]);

  const others = account.allowedProjects.filter((p) => p !== view.project);
  return (
    <li className={LINE_LOOSE}>
      <Dot tone={state.tone} aria-hidden="true" />
      <span className={cn(GROW, COLUMN, "gap-1")}>
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{account.label}</span>
          <span className="font-mono text-[12px] text-dim-foreground">{account.id}</span>
          {account.active && <Tag>used here</Tag>}
          {!account.allowed && <Tag tone="warn">not allowed here</Tag>}
        </span>
        <span className={cn("text-dim-foreground", NOTE)}>
          {state.text}
          {others.length > 0 && ` · also serves ${others.map(projectName).join(", ")}`}
        </span>
      </span>
      {!running && !account.signIn.loggedIn && account.signIn.installed && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await setup.startLogin(projectKey, view.provider, account.id);
              reload();
              return undefined;
            })
          }
        >
          Sign in
        </Button>
      )}
      {running && account.login?.url && (
        <Button
          size="sm"
          variant="neutral"
          onClick={() => void bridge.openExternal(account.login?.url ?? "")}
        >
          Open sign-in page
        </Button>
      )}
      {running && (
        <Button
          size="sm"
          variant="neutral"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await setup.cancelLogin(projectKey, view.provider, account.id);
              reload();
              return undefined;
            })
          }
        >
          Cancel
        </Button>
      )}
      {account.signIn.loggedIn && (
        <Button
          size="sm"
          variant="neutral"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const result = await setup.logout(projectKey, view.provider, account.id);
              if (!result.ok) throw new Error(result.message);
              reload();
              return undefined;
            })
          }
        >
          Sign out
        </Button>
      )}
      {account.active ? (
        <Button
          size="sm"
          variant="neutral"
          disabled={busy}
          onClick={() => void act(() => setup.chooseAccount(projectKey, view.provider, null))}
        >
          Stop using here
        </Button>
      ) : (
        <Button
          size="sm"
          variant="neutral"
          disabled={busy}
          onClick={() => void act(() => setup.chooseAccount(projectKey, view.provider, account.id))}
        >
          Use for this project
        </Button>
      )}
      <Button size="sm" variant="neutral" disabled={busy} onClick={() => setRemoving(true)}>
        Remove
      </Button>
      <ConfirmDialog
        open={removing}
        title={`Remove ${account.label}`}
        confirmLabel="Sign out and remove"
        danger
        busy={busy}
        error={removing ? error : null}
        onClose={() => setRemoving(false)}
        onConfirm={() =>
          void act(() => setup.removeAccount(projectKey, view.provider, account.id)).then(
            (ok) => ok && setRemoving(false),
          )
        }
      >
        Signs {account.label} out of the {view.name} CLI, deletes its credential folder and drops it
        from every project. Projects that used it go back to the CLI's own sign-in; none is moved to
        another account.
      </ConfirmDialog>
      {running && account.login && account.login.lines.length > 0 && (
        <pre
          className="m-0 max-h-[120px] basis-full overflow-auto whitespace-pre-wrap wrap-anywhere rounded-base border-2 border-[var(--line-strong)] bg-[var(--bg-code)] px-[10px] py-2 font-mono text-[12px]"
          aria-live="polite"
        >
          {account.login.lines.slice(-6).join("\n")}
        </pre>
      )}
      {account.login?.state === "failed" && (
        <Alert tone="error" className="basis-full">
          {account.login.error ?? "Sign-in failed."}
        </Alert>
      )}
      {error && !removing && (
        <Alert tone="error" className="basis-full">
          {error}
        </Alert>
      )}
    </li>
  );
}

function AddAccount({
  projectKey,
  provider,
  onView,
}: {
  projectKey: string;
  provider: ProviderAccounts["provider"];
  onView: (view: ProviderAccounts) => void;
}) {
  const [label, setLabel] = useState("");
  const { busy, error, act } = useAct(onView);
  const labelId = useId();
  const id = accountIdFrom(label);
  const valid = label.trim().length > 0 && ACCOUNT_ID.test(id);
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void act(() => setup.addAccount(projectKey, provider, { id, label: label.trim() })).then(
          (ok) => ok && setLabel(""),
        );
      }}
    >
      <label htmlFor={labelId} className="sr-only">
        New account label
      </label>
      <Input
        id={labelId}
        className="h-9 max-w-[280px] flex-1"
        autoComplete="off"
        placeholder="Label, e.g. Personal or Employer"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      {label.trim() && (
        <span className={cn("text-dim-foreground", NOTE)}>
          ID <span className="font-mono">{id || "?"}</span>
        </span>
      )}
      <Button type="submit" variant="secondary" size="md" disabled={busy || !valid}>
        Add account
      </Button>
      {error && (
        <Alert tone="error" className="basis-full">
          {error}
        </Alert>
      )}
    </form>
  );
}

function ProviderAccountsList({
  projectKey,
  provider,
}: {
  projectKey: string;
  provider: ProviderAccounts["provider"];
}) {
  const [accounts, reload, setAccounts] = useLoad(
    () => setup.accounts(projectKey, provider),
    [projectKey, "accounts", provider],
  );
  if (accounts.state !== "ready")
    return <LoadState value={accounts} what={`${provider} accounts`} />;
  const view = accounts.data;
  return (
    <div className="min-w-0 rounded-base border-2 border-border bg-background">
      <header className="flex flex-wrap items-baseline gap-2 border-b-2 border-border px-3 py-2">
        <span className="text-[15px] font-bold">{view.name}</span>
        <span className={cn("text-dim-foreground", NOTE)}>
          this project uses {activeLabel(view)}
        </span>
      </header>
      {view.accounts.length > 0 ? (
        <ul className="m-0 flex list-none flex-col divide-y-2 divide-border p-0">
          {view.accounts.map((account) => (
            <AccountRow
              key={account.id}
              projectKey={projectKey}
              view={view}
              account={account}
              onView={setAccounts}
              reload={reload}
            />
          ))}
        </ul>
      ) : (
        <p className={cn("m-0 px-3 py-2 text-dim-foreground", NOTE)}>
          No accounts. Every project uses the {view.name} CLI's own sign-in.
        </p>
      )}
      <AddAccount projectKey={projectKey} provider={provider} onView={setAccounts} />
    </div>
  );
}

/**
 * Accounts on the Providers page (#2303): several subscriptions of one provider, such as a
 * personal plan and an employer's seat, each with its own sign-in, and which one the project
 * this page reads through uses. Shown only by backends with the `provider-accounts` capability.
 */
export function AccountsPanel({
  projectKey,
  projectName: name,
}: {
  projectKey: string;
  projectName: string;
}) {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    let live = true;
    setup.canUseAccounts(projectKey).then(
      (yes) => live && setOffered(yes),
      () => live && setOffered(false),
    );
    return () => {
      live = false;
    };
  }, [projectKey]);
  if (!offered) return null;
  return (
    <TonePanel
      title="Accounts"
      icon="shield"
      tone="accent"
      about={
        <>
          Sign into several subscriptions of one provider, such as a personal plan and an employer's
          or client's seat, and choose which one <strong>{name}</strong> uses. A project uses an
          account only once you choose it there; BAKED never moves it to another account by itself.
        </>
      }
    >
      <div className="grid min-w-0 gap-3">
        {PROVIDERS.map((provider) => (
          <ProviderAccountsList key={provider} projectKey={projectKey} provider={provider} />
        ))}
      </div>
    </TonePanel>
  );
}
