import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AttentionItem } from "../../../shared/api.js";
import { attentionTitle, kindLabel } from "../../../shared/attention.js";
import { ApiError } from "../../client/api.js";
import { ago } from "../../format.js";

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
      <div className="att-head">
        <h2>{attentionTitle(item)}</h2>
        {aside}
      </div>
      <p className="att-meta">
        <span className="att-project">{item.projectName}</span> · {kindLabel(item.kind)} ·{" "}
        {item.blocking ? "blocking" : "advisory"} · {ago(item.createdAt)}
      </p>
    </>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="card att-fact">
      <span className="label">{label}</span>
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
  if (load.state === "loading") return <p className="muted">Loading…</p>;
  if (load.state === "error")
    return (
      <div className="banner error" role="alert">
        {load.message}
      </div>
    );
  return <>{children(load.value)}</>;
}

export function ActionError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="banner error" role="alert">
      {error}
    </div>
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
      <button type="button" className="btn att-btn" disabled={busy} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <form
      className="att-reject"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason.trim()) onReject(reason.trim());
      }}
    >
      <label className="label" htmlFor="att-reason">
        Why? The agents read this.
      </label>
      <textarea
        id="att-reason"
        className="att-input"
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="att-actions">
        <button type="submit" className="btn att-btn" disabled={busy || !reason.trim()}>
          {label}
        </button>
        <button type="button" className="btn att-btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
