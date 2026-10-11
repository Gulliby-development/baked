import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AttentionItem } from "../../../shared/api.js";
import { attentionTitle, kindLabel } from "../../../shared/attention.js";
import { ApiError } from "../../client/api.js";
import { Alert } from "../../components/ui/alert.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { ago } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LABEL, PANEL } from "../../lib/styles.js";

/** Class strings the detail panes share; BTN sizes the action buttons up from the `md` button. */
export const BTN = "min-h-[42px] px-[18px] no-underline";
/** A link styled as a secondary action button. */
export const LINK_BTN = cn(buttonVariants({ variant: "secondary", size: "md" }), BTN);
export const ACTIONS = "flex flex-wrap items-center gap-2";
export const LEDE = "m-0 leading-[1.6] text-muted-foreground";
export const NOTE = "m-0 text-[13px] text-muted-foreground";
export const ASIDE = "text-[12px] text-[color:var(--ok)]";
export const FACTS = "grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3";
export const LIST = cn(PANEL, "flex flex-col gap-2");
export const ROW =
  "flex min-w-0 justify-between gap-3 text-[13px] [&>:first-child]:wrap-anywhere [&>:last-child]:flex-none";
export const FORM = "flex flex-col gap-3";
// `!` keeps the fill above the unlayered `textarea` rule in runs.css while that stylesheet exists.
export const INPUT =
  "w-full resize-y rounded-base border-2 border-border bg-raised! px-[10px] py-2 text-foreground [font:inherit]";
export const PROJECT = "text-[color:var(--info)]";

export function errorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404 && error.message.startsWith("No endpoint"))
    return "Needs a newer BAKED: this project's backend cannot answer this item yet.";
  return error instanceof Error ? error.message : String(error);
}

export type Load<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; value: T };

/** Loads once per key; `reload` fetches again after an action. */
export function useLoad<T>(load: () => Promise<T>, key: string): [Load<T>, () => void] {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  const [epoch, setEpoch] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what `load` reads; epoch forces a reload
  useEffect(() => {
    let live = true;
    setResult({ state: "loading" });
    load().then(
      (value) => live && setResult({ state: "ready", value }),
      (error: unknown) => live && setResult({ state: "error", message: errorText(error) }),
    );
    return () => {
      live = false;
    };
  }, [key, epoch]);
  return [result, useCallback(() => setEpoch((e) => e + 1), [])];
}

/** Runs one action at a time and keeps its error. */
export function useAction(): {
  busy: boolean;
  error: string | null;
  run: (work: () => Promise<void>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

export function DetailHeader({ item, aside }: { item: AttentionItem; aside?: ReactNode }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-[18px] font-semibold">{attentionTitle(item)}</h2>
        {aside}
      </div>
      <p className="mx-0 -mt-[10px] mb-0 text-[12px] text-dim-foreground">
        <span className={PROJECT}>{item.projectName}</span> · {kindLabel(item.kind)} ·{" "}
        {item.blocking ? "blocking" : "advisory"} · {ago(item.createdAt)}
      </p>
    </>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={cn(PANEL, "flex min-w-0 flex-col gap-1 text-[13px] wrap-anywhere")}>
      <span className={LABEL}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function Loading<T>({
  load,
  children,
}: {
  load: Load<T>;
  children: (value: T) => ReactNode;
}) {
  if (load.state === "loading") return <p className="text-dim-foreground">Loading…</p>;
  if (load.state === "error")
    return (
      <Alert tone="error" role="alert">
        {load.message}
      </Alert>
    );
  return <>{children(load.value)}</>;
}

export function ActionError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Alert tone="error" role="alert">
      {error}
    </Alert>
  );
}

/** A reason field that opens under the Reject button. */
export function RejectForm({
  busy,
  label = "Reject",
  onReject,
}: {
  busy: boolean;
  label?: string;
  onReject: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open)
    return (
      <Button
        variant="secondary"
        size="md"
        className={BTN}
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
    );
  return (
    <form
      className={cn(FORM, "basis-full")}
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim()) onReject(reason.trim());
      }}
    >
      <label className={LABEL} htmlFor="att-reason">
        Why? The agents read this.
      </label>
      <textarea
        id="att-reason"
        className={INPUT}
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className={ACTIONS}>
        <Button
          type="submit"
          variant="secondary"
          size="md"
          className={BTN}
          disabled={busy || !reason.trim()}
        >
          {label}
        </Button>
        <Button variant="secondary" size="md" className={BTN} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
