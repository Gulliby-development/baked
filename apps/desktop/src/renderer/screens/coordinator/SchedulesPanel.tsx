import { useCallback, useEffect, useState } from "react";
import { coordinator, type Schedule } from "../../client/coordinator.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Input } from "../../components/ui/input.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE } from "../../lib/styles.js";
import { describeWhen, nextLabel, WHEN_PRESETS } from "./schedules.js";

/** How often the list is read again, so a fired schedule shows its next time. */
const REFRESH_MS = 15_000;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const RISE = "animate-rise motion-reduce:animate-none";

function ScheduleCard({
  schedule,
  onToggle,
  onRemove,
}: {
  schedule: Schedule;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const on = schedule.enabled;
  return (
    <li
      className={cn(
        "flex flex-col gap-1 rounded-base border-2 border-border px-3 py-2 transition-[opacity,background-color] duration-300",
        on ? "bg-background shadow-shadow" : "bg-secondary-background opacity-70",
        RISE,
      )}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "grid size-6 flex-none place-items-center rounded-full border-2 border-border text-[12px] transition-colors duration-300",
            on ? "bg-main text-main-foreground" : "bg-secondary-background text-dim-foreground",
          )}
        >
          ◷
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {schedule.name}
        </span>
        <Switch
          checked={on}
          aria-label={on ? `Pause ${schedule.name}` : `Resume ${schedule.name}`}
          onCheckedChange={(checked) => onToggle(checked)}
        />
      </div>
      <p className="m-0 flex flex-wrap gap-x-3 font-mono text-[12px] text-dim-foreground">
        <span>{describeWhen(schedule.when)}</span>
        <span className={on ? "text-foreground" : undefined}>
          {on ? `next ${nextLabel(schedule)}` : "paused"}
        </span>
      </p>
      <p className="m-0 line-clamp-2 text-[13px] text-soft-foreground" title={schedule.prompt}>
        {schedule.prompt}
      </p>
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </li>
  );
}

function AddSchedule({
  onAdd,
  onCancel,
}: {
  onAdd: (input: { name: string; prompt: string; when: string }) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [when, setWhen] = useState(WHEN_PRESETS[1]?.when ?? "@daily");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim() && prompt.trim() && when.trim();
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(await onAdd({ name: name.trim(), prompt: prompt.trim(), when: when.trim() }));
    setBusy(false);
  };
  return (
    <form
      className={cn(
        "flex flex-col gap-2 rounded-base border-2 border-border bg-background p-3 shadow-shadow",
        RISE,
      )}
      aria-label="New schedule"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) void submit();
      }}
    >
      <Input
        aria-label="Name"
        placeholder="Name, such as Morning summary"
        value={name}
        maxLength={120}
        onChange={(event) => setName(event.target.value)}
      />
      <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0" aria-label="When">
        {WHEN_PRESETS.map((preset) => (
          <button
            key={preset.when}
            type="button"
            aria-pressed={when === preset.when}
            onClick={() => setWhen(preset.when)}
            className={cn(
              "rounded-full border-2 border-border px-2 py-0.5 text-[12px] transition-[transform,background-color] duration-150 hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
              when === preset.when
                ? "bg-main text-main-foreground"
                : "bg-secondary-background text-foreground",
            )}
          >
            {preset.label}
          </button>
        ))}
      </fieldset>
      <Input
        aria-label="When"
        className="font-mono"
        placeholder="every 6h, 0 9 * * 1-5 or @daily"
        value={when}
        onChange={(event) => setWhen(event.target.value)}
      />
      <Textarea
        aria-label="What the coordinator does"
        placeholder="What the coordinator does each time, such as: summarize what finished overnight"
        rows={3}
        maxLength={4000}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!ready || busy}>
          Add schedule
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The coordinator's schedules: prompts that start a coordinator turn on their own while this
 * project's server runs. Each one can be paused, resumed or removed; Add opens a short form.
 */
export function SchedulesPanel({ projectKey }: { projectKey: string }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const reload = useCallback(() => {
    coordinator.schedules(projectKey).then(
      (view) => setSchedules(view.schedules),
      (e: unknown) => setError(message(e)),
    );
  }, [projectKey]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const add = async (input: { name: string; prompt: string; when: string }) => {
    try {
      const added = await coordinator.addSchedule(projectKey, input);
      setSchedules((list) => [...(list ?? []), added]);
      setAdding(false);
      return null;
    } catch (e) {
      return message(e);
    }
  };
  const toggle = async (schedule: Schedule, enabled: boolean): Promise<void> => {
    // The switch moves at once; a refused change puts it back.
    setSchedules(
      (list) => list?.map((s) => (s.id === schedule.id ? { ...s, enabled } : s)) ?? null,
    );
    try {
      const changed = await coordinator.setScheduleEnabled(projectKey, schedule.id, enabled);
      setSchedules((list) => list?.map((s) => (s.id === changed.id ? changed : s)) ?? null);
      setError(null);
    } catch (e) {
      setError(message(e));
      reload();
    }
  };
  const remove = async (schedule: Schedule): Promise<void> => {
    try {
      await coordinator.removeSchedule(projectKey, schedule.id);
      setSchedules((list) => list?.filter((s) => s.id !== schedule.id) ?? null);
      setRemoving(null);
      setError(null);
    } catch (e) {
      setError(message(e));
      setRemoving(null);
      reload();
    }
  };

  return (
    <section className="flex flex-col gap-2" aria-label="Schedules">
      <div className="flex items-center gap-2">
        <h2 className={cn(LABEL, "flex-1")}>Schedules</h2>
        {!adding && (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            Add
          </Button>
        )}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {adding && <AddSchedule onAdd={add} onCancel={() => setAdding(false)} />}
      {schedules && schedules.length === 0 && !adding && (
        <p className={LEDE}>
          None. A schedule starts a coordinator turn on its own, such as a nightly CI check, while
          this project is open. You can also ask the coordinator to add one.
        </p>
      )}
      {schedules && schedules.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {schedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              onToggle={(enabled) => void toggle(schedule, enabled)}
              onRemove={() => setRemoving(schedule)}
            />
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        title="Remove schedule"
        confirmLabel="Remove"
        danger
        onConfirm={() => removing && void remove(removing)}
        onClose={() => setRemoving(null)}
      >
        {removing ? `"${removing.name}" stops firing and is deleted.` : ""}
      </ConfirmDialog>
    </section>
  );
}
