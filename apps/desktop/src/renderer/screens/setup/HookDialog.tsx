import { useState } from "react";
import {
  HOOK_PHASES,
  HOOK_TEMPLATES,
  type HookPlatform,
} from "../../../../../../src/core/hooks/catalog.js";
import type { HookCommand, HooksView } from "../../client/setup.js";
import { Icon } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { fieldClass, Input } from "../../components/ui/input.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import { Hint } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/cn.js";
import { LABEL } from "../../lib/styles.js";
import {
  BLANK_FORM,
  eventInfo,
  formFromTemplate,
  formProblem,
  type HookForm,
  jsonPreview,
  PICKABLE_EVENTS,
} from "./hooks-logic.js";
import { FIELD_HALF, FL, FORM, NOTE, PAIR } from "./shared.js";

/** What the dialog is open for: a new hook (maybe from a template or a copy), or an edit. */
export type HookDialogState =
  | { kind: "new"; form: HookForm | null }
  | { kind: "edit"; form: HookForm; hook: HookCommand };

const RISE = "animate-rise motion-reduce:animate-none";
const CHIP =
  "inline-flex cursor-pointer items-center rounded-full border-2 border-border bg-raised px-2 py-0.5 font-mono text-[11px] text-soft-foreground shadow-sm-hard transition-[transform,box-shadow] duration-[80ms] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none aria-pressed:bg-main aria-pressed:text-main-foreground motion-reduce:transition-none";

/** The first step of a new hook: a template or a blank form. */
function TemplatePicker({
  platform,
  onPick,
}: {
  platform: HookPlatform;
  onPick: (form: HookForm) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {HOOK_TEMPLATES.map((template, index) => {
        const info = eventInfo(template.event);
        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onPick(formFromTemplate(template, platform))}
            style={{ animationDelay: `${index * 40}ms` }}
            className={cn(
              RISE,
              "flex cursor-pointer flex-col items-start gap-2 rounded-base border-2 border-border bg-background p-3 text-left [font:inherit] text-foreground shadow-sm-hard transition-[transform,box-shadow] duration-[80ms] hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-hover hover:shadow-none motion-reduce:transition-none",
            )}
          >
            <span className="text-[14px] font-bold">{template.title}</span>
            <span className={cn(NOTE, "text-muted-foreground")}>{template.description}</span>
            <Badge tone="accent" className="mt-auto normal-case tracking-normal">
              {info?.title ?? template.event}
            </Badge>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => onPick(BLANK_FORM)}
        style={{ animationDelay: `${HOOK_TEMPLATES.length * 40}ms` }}
        className={cn(
          RISE,
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-base border-2 border-dashed border-border bg-transparent p-3 [font:inherit] text-soft-foreground hover:bg-hover hover:text-foreground",
        )}
      >
        <Icon name="new" size={20} />
        <span className="text-[14px] font-bold">Blank hook</span>
      </button>
    </div>
  );
}

function Toggle({
  id,
  label,
  note,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  note: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-w-[200px] flex-1 items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next)}
        aria-label={label}
      />
      <label htmlFor={id} className="flex cursor-pointer flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-foreground">{label}</span>
        <span className={cn(NOTE, "text-dim-foreground")}>{note}</span>
      </label>
    </div>
  );
}

function HookFormFields({
  form,
  onChange,
  targets,
  redacted,
}: {
  form: HookForm;
  onChange: (form: HookForm) => void;
  targets: HooksView["targets"];
  redacted: boolean;
}) {
  const [showJson, setShowJson] = useState(false);
  const info = eventInfo(form.event);
  const set = <K extends keyof HookForm>(key: K, value: HookForm[K]) =>
    onChange({ ...form, [key]: value });
  const options = PICKABLE_EVENTS.some((e) => e.event === form.event)
    ? PICKABLE_EVENTS
    : [...PICKABLE_EVENTS, ...(info ? [info] : [])];
  return (
    <div className={cn(FORM, "gap-4")}>
      <div className={FL}>
        <label htmlFor="hook-event">When</label>
        <select
          id="hook-event"
          className={cn(fieldClass, "h-10")}
          value={form.event}
          onChange={(e) => set("event", e.target.value)}
        >
          {HOOK_PHASES.map((phase) => {
            const events = options.filter((e) => e.phase === phase.id);
            if (events.length === 0) return null;
            return (
              <optgroup key={phase.id} label={phase.title}>
                {events.map((e) => (
                  <option key={e.event} value={e.event}>
                    {e.title} ({e.event})
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        {info && (
          <span
            key={info.event}
            className={cn(RISE, "flex flex-col gap-1 text-[12px] text-muted-foreground")}
          >
            {info.summary}
            {info.blocks && (
              <span className="text-soft-foreground">
                <b>Can stop it:</b> {info.blocks}
              </span>
            )}
          </span>
        )}
      </div>

      {info?.matcher && (
        <div className={cn(FL, RISE)}>
          <label htmlFor="hook-matcher">
            Only for these {info.matcher.target}s
            <Hint label="matcher">
              Leave it empty to run for every {info.matcher.target}. Separate names with |, or write
              a regular expression such as ^mcp__.*
            </Hint>
          </label>
          <Input
            id="hook-matcher"
            className="font-mono"
            placeholder={`Any ${info.matcher.target}`}
            value={form.matcher}
            onChange={(e) => set("matcher", e.target.value)}
          />
          <span className="flex flex-wrap gap-1.5">
            {info.matcher.examples.map((example) => (
              <button
                key={example}
                type="button"
                className={CHIP}
                aria-pressed={form.matcher === example}
                onClick={() => set("matcher", form.matcher === example ? "" : example)}
              >
                {example}
              </button>
            ))}
          </span>
        </div>
      )}

      <div className={FL}>
        <label htmlFor="hook-command">
          Run this command
          <Hint label="command">
            Runs in the project folder with the event as JSON on stdin. Exit code 2 stops the action
            where the event allows it; stderr becomes the reason.
          </Hint>
        </label>
        <Textarea
          id="hook-command"
          className="min-h-[72px] font-mono text-[13px]"
          placeholder="./scripts/check.sh"
          spellCheck={false}
          value={form.command}
          onChange={(e) => set("command", e.target.value)}
        />
        {redacted && (
          <span className={cn(NOTE, "text-[var(--warn)]")}>
            A secret in this command is hidden. Leave the command as it is to keep the stored value.
          </span>
        )}
      </div>

      {info?.matcher?.target === "tool name" && (
        <div className={FL}>
          <label htmlFor="hook-if">
            And only if the input matches
            <Hint label="condition">
              Tool(pattern): the tool's first argument must match the pattern, for example Bash(git
              push *) or Edit(*.ts). Leave it empty to skip this check.
            </Hint>
          </label>
          <Input
            id="hook-if"
            className="font-mono"
            placeholder="Bash(git push *)"
            value={form.if}
            onChange={(e) => set("if", e.target.value)}
          />
        </div>
      )}

      <div className={cn(PAIR, "items-start gap-4")}>
        <Toggle
          id="hook-async"
          label="Run in the background"
          note="The agent goes on without waiting, and the hook cannot stop anything."
          checked={form.async}
          onChange={(value) => set("async", value)}
        />
        <Toggle
          id="hook-once"
          label="Once per session"
          note="Later events in the same session skip it."
          checked={form.once}
          onChange={(value) => set("once", value)}
        />
      </div>

      <div className={PAIR}>
        <div className={cn(FIELD_HALF, "max-w-[180px]")}>
          <label htmlFor="hook-timeout">Timeout, seconds</label>
          <Input
            id="hook-timeout"
            inputMode="numeric"
            placeholder="10"
            value={form.timeout}
            onChange={(e) => set("timeout", e.target.value)}
          />
        </div>
        <div className={cn(FIELD_HALF, "flex-[3_1_260px]")}>
          <span id="hook-scope">Save to</span>
          <SegmentGroup aria-labelledby="hook-scope">
            <Segment
              aria-pressed={form.scope === "project"}
              onClick={() => set("scope", "project")}
            >
              This project
            </Segment>
            <Segment aria-pressed={form.scope === "user"} onClick={() => set("scope", "user")}>
              All my projects
            </Segment>
          </SegmentGroup>
          <span className="truncate font-mono text-[11px]" title={targets[form.scope]}>
            {targets[form.scope]}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          className={cn(
            LABEL,
            "flex w-fit cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 hover:text-foreground",
          )}
          aria-expanded={showJson}
          onClick={() => setShowJson(!showJson)}
        >
          <Icon
            name="chevron-right"
            size={12}
            className={cn("transition-transform duration-150", showJson && "rotate-90")}
          />
          What gets saved
        </button>
        {showJson && (
          <pre
            className={cn(
              RISE,
              "m-0 overflow-auto rounded-base border-2 border-border bg-secondary-background p-3 font-mono text-[12px] text-soft-foreground",
            )}
          >
            {jsonPreview(form)}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * New hook and Edit hook: a template first for a new one, then the form. Saving writes BAKED's own
 * config file through the backend; the dialog stays open with the error when that fails.
 */
export function HookDialog({
  state,
  targets,
  platform,
  busy,
  error,
  onPickTemplate,
  onChange,
  onSave,
  onClose,
}: {
  state: HookDialogState | null;
  targets: HooksView["targets"];
  platform: HookPlatform;
  busy: boolean;
  error: string | null;
  /** A template's form, or null to go back to the templates. */
  onPickTemplate: (form: HookForm | null) => void;
  onChange: (form: HookForm) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const form = state?.form ?? null;
  const problem = form ? formProblem(form) : null;
  const editing = state?.kind === "edit";
  return (
    <Dialog open={state !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="w-[min(720px,calc(100vw-48px))]">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit hook" : "New hook"}</DialogTitle>
          <DialogDescription>
            {form
              ? "Pick the moment, the command and where to keep it."
              : "Start from a ready-made hook or a blank one. You can change every field next."}
          </DialogDescription>
        </DialogHeader>
        {form ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!problem) onSave();
            }}
          >
            <HookFormFields
              form={form}
              onChange={onChange}
              targets={targets}
              redacted={editing && state.hook.redacted}
            />
            {error && <Alert tone="error">{error}</Alert>}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {problem && (
                <span className={cn(NOTE, "mr-auto text-dim-foreground")}>{problem}</span>
              )}
              {!editing && (
                <Button
                  variant="ghost"
                  size="md"
                  disabled={busy}
                  onClick={() => onPickTemplate(null)}
                >
                  Back to templates
                </Button>
              )}
              <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="md" disabled={busy || problem !== null}>
                {busy ? "Saving…" : editing ? "Save changes" : "Add hook"}
              </Button>
            </div>
          </form>
        ) : (
          <TemplatePicker platform={platform} onPick={onPickTemplate} />
        )}
      </DialogContent>
    </Dialog>
  );
}
