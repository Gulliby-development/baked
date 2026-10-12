import { useEffect, useState } from "react";
import type { DefinitionSummary } from "../../client/runs.js";
import { type GateDraft, type GateDraftKind, type GatePlaces, setup } from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { Textarea } from "../../components/ui/textarea.js";
import { cn } from "../../lib/cn.js";
import { definitions } from "../runs/load.js";
import {
  draftLines,
  firstOpenPlace,
  GATE_KINDS,
  GATE_SETUP_STEPS,
  type GateSetupStep,
  kindInfo,
} from "./gate-setup-model.js";
import { errorText } from "./shared.js";

const CHOICE =
  "flex w-full flex-col items-start gap-1 rounded-base border-2 border-border bg-secondary-background px-3 py-2.5 text-left shadow-shadow transition-transform hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none data-[on=true]:bg-main data-[on=true]:text-main-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-shadow";
const ACTIONS = "flex flex-wrap items-center gap-2";

function Steps({ current }: { current: GateSetupStep }) {
  const at = GATE_SETUP_STEPS.findIndex((s) => s.step === current);
  return (
    <ol className="m-0 flex list-none flex-wrap gap-2 p-0 text-[12px]" aria-label="Steps">
      {GATE_SETUP_STEPS.map((s, i) => (
        <li
          key={s.step}
          aria-current={i === at ? "step" : undefined}
          className={cn(
            "rounded-base border-2 border-border px-2 py-0.5",
            i === at ? "bg-main text-main-foreground" : i < at ? "" : "text-dim-foreground",
          )}
        >
          {i + 1}. {s.title}
        </li>
      ))}
    </ol>
  );
}

function SetupFlow({
  projectKey,
  onSaved,
  onDone,
}: {
  projectKey: string;
  onSaved: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<GateSetupStep>("kind");
  const [kind, setKind] = useState<GateDraftKind>("command");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<GateDraft | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<DefinitionSummary[]>([]);
  const [workflow, setWorkflow] = useState("sdd");
  const [places, setPlaces] = useState<GatePlaces | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [bound, setBound] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const work = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (step !== "place") return;
    void definitions(projectKey).then(setWorkflows);
  }, [step, projectKey]);
  useEffect(() => {
    if (step !== "place" || !saved) return;
    let live = true;
    setPlaces(null);
    setup.gatePlaces(projectKey, saved, workflow).then(
      (result) => {
        if (!live) return;
        setPlaces(result);
        setPlace(firstOpenPlace(result));
      },
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [step, saved, workflow, projectKey]);

  const info = kindInfo(kind);
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Set up a gate</DialogTitle>
        <DialogDescription>
          One gate at a time: what kind of check, the check in your own words, what BAKED drafted,
          and where it runs in the workflow.
        </DialogDescription>
      </DialogHeader>
      <Steps current={step} />

      {step === "kind" && (
        <div className="grid grid-cols-2 gap-2.5 [@media(max-width:640px)]:grid-cols-1">
          {GATE_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={CHOICE}
              data-on={kind === k.kind}
              aria-pressed={kind === k.kind}
              onClick={() => setKind(k.kind)}
            >
              <span className="font-bold">{k.title}</span>
              <span className="text-[12px] opacity-80">{k.what}</span>
            </button>
          ))}
        </div>
      )}

      {step === "describe" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="gate-text">{info?.title}: describe the check in plain words</Label>
          <Textarea
            id="gate-text"
            rows={4}
            value={text}
            placeholder={info?.placeholder}
            disabled={busy}
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
          <span className="text-[12px] text-dim-foreground">
            {info?.usesModel
              ? "The project's model drafts the gate from this; nothing is saved until you read it."
              : "No model is needed for this kind; the sentence becomes the gate's text."}
          </span>
        </div>
      )}

      {step === "review" && draft && (
        <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
          <span className="text-[12px] text-dim-foreground">
            <span className="font-mono">{draft.gate.id}</span> ·{" "}
            {draft.gate.required ? "blocks the run" : "advisory, never blocks"} · saved to{" "}
            <span className="font-mono">{draft.path}</span>
          </span>
          {draftLines(draft).map((group) => (
            <section key={group.label} className="flex flex-col gap-1">
              <span className="text-[12px] font-bold uppercase tracking-wide">{group.label}</span>
              {group.lines.map((line) => (
                <span key={line} className="text-[13px]">
                  {line}
                </span>
              ))}
            </section>
          ))}
          {draft.script && (
            <details>
              <summary className="cursor-pointer text-[12px]">
                Test script <span className="font-mono">{draft.script.path}</span>
              </summary>
              <pre className="mt-1 overflow-x-auto rounded-base border-2 border-border p-2 text-[12px]">
                {draft.script.content}
              </pre>
            </details>
          )}
          {draft.problems.length > 0 && (
            <Alert tone="error">Cannot be saved: {draft.problems.join("; ")}</Alert>
          )}
        </div>
      )}

      {step === "place" && (
        <div className="flex flex-col gap-3">
          {bound ? (
            <Alert role="status">{bound}</Alert>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="gate-workflow">Workflow</Label>
                <select
                  id="gate-workflow"
                  className="min-h-[38px] rounded-base border-2 border-border bg-background px-2 text-foreground"
                  value={workflow}
                  onChange={(event) => setWorkflow(event.target.value)}
                >
                  {(workflows.length ? workflows.map((w) => w.id) : ["sdd"]).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                {places?.copyTo && (
                  <span className="text-[12px] text-dim-foreground">
                    {workflow} is built in, so BAKED saves a copy as{" "}
                    <span className="font-mono">{places.copyTo}</span> with the gate in it.
                  </span>
                )}
              </div>
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-1 text-[12px] font-bold uppercase tracking-wide">
                  Where it runs
                </legend>
                {!places && <span className="text-[12px] text-dim-foreground">Loading…</span>}
                {places?.places.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={CHOICE}
                    data-on={place === p.key}
                    aria-pressed={place === p.key}
                    disabled={p.disabled !== null || p.bound}
                    onClick={() => setPlace(p.key)}
                  >
                    <span>{p.label}</span>
                    {(p.disabled || p.bound) && (
                      <span className="text-[12px] opacity-80">
                        {p.bound ? "already here" : p.disabled}
                      </span>
                    )}
                  </button>
                ))}
              </fieldset>
            </>
          )}
        </div>
      )}

      {error && (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      )}

      <div className={ACTIONS}>
        {step === "kind" && (
          <Button variant="primary" size="md" onClick={() => setStep("describe")}>
            Next
          </Button>
        )}
        {step === "describe" && (
          <>
            <Button
              variant="primary"
              size="md"
              disabled={busy || !text.trim()}
              onClick={() =>
                void work(async () => {
                  setDraft(await setup.draftGate(projectKey, text, kind));
                  setStep("review");
                })
              }
            >
              {busy ? "Drafting…" : "Draft the gate"}
            </Button>
            <Button variant="secondary" size="md" disabled={busy} onClick={() => setStep("kind")}>
              Back
            </Button>
          </>
        )}
        {step === "review" && draft && (
          <>
            <Button
              variant="primary"
              size="md"
              disabled={busy || draft.problems.length > 0}
              onClick={() =>
                void work(async () => {
                  const result = await setup.saveGate(projectKey, draft);
                  setSaved(result.id);
                  onSaved();
                  setStep("place");
                })
              }
            >
              Save gate
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => setStep("describe")}
            >
              Back
            </Button>
          </>
        )}
        {step === "place" && !bound && saved && (
          <>
            <Button
              variant="primary"
              size="md"
              disabled={busy || !place}
              onClick={() =>
                void work(async () => {
                  if (!place) return;
                  const result = await setup.bindGate(projectKey, saved, workflow, place);
                  setBound(
                    `${saved} runs in ${result.workflowId} (${result.path}).${result.copiedFrom ? ` Start runs with the ${result.workflowId} workflow to use it.` : ""}`,
                  );
                })
              }
            >
              Add to workflow
            </Button>
            <Button variant="secondary" size="md" disabled={busy} onClick={onDone}>
              Later
            </Button>
          </>
        )}
        {(step !== "place" || bound) && (
          <Button variant="secondary" size="md" onClick={onDone}>
            {bound ? "Done" : "Cancel"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The step-by-step gate setup; it starts fresh each time it opens. */
export function GateSetupDialog({
  projectKey,
  open,
  onOpenChange,
  onSaved,
}: {
  projectKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(680px,calc(100vw-48px))]">
        {open && (
          <SetupFlow projectKey={projectKey} onSaved={onSaved} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
