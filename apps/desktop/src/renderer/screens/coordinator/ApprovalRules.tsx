import { useCallback, useEffect, useId, useState } from "react";
import { ApiError } from "../../client/api.js";
import { type ApprovalRule, type ApprovalRules, coordinator } from "../../client/coordinator.js";
import { Icon } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Switch } from "../../components/ui/switch.js";
import { ago } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE } from "../../lib/styles.js";
import {
  ALWAYS_YOURS,
  emptyDraft,
  RULE_KIND_ORDER,
  RULE_KINDS,
  type RuleDraft,
  ruleFromDraft,
  ruleLine,
} from "./rules.js";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Answers shown under the rules, newest first. */
const RECENT = 5;

function RuleCard({
  rule,
  enabled,
  busy,
  onRemove,
}: {
  rule: ApprovalRule;
  enabled: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const kind = RULE_KINDS[rule.kind];
  return (
    <li
      className={cn(
        "flex min-w-0 items-start gap-2.5 rounded-base border-2 border-border bg-background px-3 py-2.5 shadow-sm-hard transition-opacity duration-200 animate-rise motion-reduce:animate-none",
        !enabled && "opacity-60",
      )}
    >
      <span
        className={cn(
          "flex size-7 flex-none items-center justify-center rounded-base border-2 border-border transition-colors duration-200",
          enabled ? "bg-main text-main-foreground" : "bg-secondary-background text-dim-foreground",
        )}
        aria-hidden="true"
      >
        <Icon name={kind.icon} size={14} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-dim-foreground">
          {kind.label}
        </span>
        <p className="m-0 text-[13px] text-foreground">{ruleLine(rule)}</p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        aria-label={`Remove the rule: ${ruleLine(rule)}`}
        onClick={onRemove}
      >
        <Icon name="delete" size={14} />
      </Button>
    </li>
  );
}

function AddRule({
  rules,
  busy,
  onAdd,
  onCancel,
}: {
  rules: ApprovalRule[];
  busy: boolean;
  onAdd: (rule: ApprovalRule) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const set = (patch: Partial<RuleDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };
  const add = () => {
    const built = ruleFromDraft(draft, rules);
    if ("error" in built) setError(built.error);
    else onAdd(built.rule);
  };
  const field = (
    label: string,
    key: "hosts" | "maxSteps" | "maxTokens" | "paths",
    placeholder: string,
    numeric = false,
  ) => (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={`${formId}-${key}`}
        className="text-[12px] font-semibold text-soft-foreground"
      >
        {label}
      </label>
      <Input
        id={`${formId}-${key}`}
        className="h-9"
        value={draft[key]}
        placeholder={placeholder}
        inputMode={numeric ? "decimal" : "text"}
        aria-invalid={error !== null}
        onChange={(event) => set({ [key]: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
      />
    </div>
  );
  return (
    <form
      className="flex flex-col gap-2.5 rounded-base border-2 border-border bg-background px-3 py-3 shadow-sm-hard animate-rise motion-reduce:animate-none"
      aria-label="Add an approval rule"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <fieldset className="m-0 grid grid-cols-2 gap-1.5 border-0 p-0">
        <legend className="sr-only">What the rule approves</legend>
        {RULE_KIND_ORDER.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={draft.kind === kind}
            className="flex min-h-[32px] cursor-pointer items-center gap-1.5 rounded-base border-2 border-border bg-raised px-2.5 [font-family:inherit] text-[12px] font-semibold text-soft-foreground transition-[background-color,color,transform] duration-150 hover:-translate-y-px aria-pressed:bg-main aria-pressed:text-main-foreground motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            onClick={() => set({ kind })}
          >
            <Icon name={RULE_KINDS[kind].icon} size={13} />
            {RULE_KINDS[kind].label}
          </button>
        ))}
      </fieldset>
      <p className={LEDE}>{RULE_KINDS[draft.kind].help}</p>
      {draft.kind === "fetch-page" && field("Hosts", "hosts", "docs.github.com, bun.sh")}
      {draft.kind === "plan-review" && field("At most steps", "maxSteps", "5", true)}
      {draft.kind === "run-approval" && (
        <>
          {field("Budget up to, million tokens", "maxTokens", "2", true)}
          {field("Only these paths (optional)", "paths", "src/**, tests/**")}
        </>
      )}
      {error && (
        <Alert tone="error" role="alert" className="px-3 py-2 text-[12px]">
          {error}
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          Add rule
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The rules the coordinator answers routine approvals of its launched work by: a switch that is
 * off by default, the rules, what always waits for the person, and the latest answers.
 */
export function ApprovalRulesSection({ projectKey }: { projectKey: string }) {
  const [rules, setRules] = useState<ApprovalRules | null>(null);
  const [missing, setMissing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const reload = useCallback(() => {
    coordinator.approvalRules(projectKey).then(setRules, (e: unknown) => {
      // An older backend has no rules; the section stays out of the way.
      if (e instanceof ApiError && e.status === 404) setMissing(true);
    });
  }, [projectKey]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  if (missing) return null;

  const save = async (next: Pick<ApprovalRules, "enabled" | "rules">): Promise<boolean> => {
    if (!rules) return false;
    setBusy(true);
    setNote(null);
    try {
      setRules(await coordinator.saveApprovalRules(projectKey, next, rules.revision));
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setNote("The rules changed meanwhile. They are reloaded; try again.");
        reload();
      } else setNote(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const recent = rules ? rules.log.slice(-RECENT).reverse() : [];
  return (
    <section className="flex flex-col gap-2.5" aria-label="Approval rules">
      <div className="flex items-center gap-2">
        <h2 className={cn(LABEL, "flex-1")}>Approval rules</h2>
        {rules && (
          <Switch
            checked={rules.enabled}
            disabled={busy}
            aria-label="Answer approvals by these rules"
            onCheckedChange={(enabled) => void save({ enabled, rules: rules.rules })}
          />
        )}
      </div>
      <p className={LEDE}>
        {rules?.enabled
          ? "On: the coordinator answers matching approvals of what it launched and notes each one in its chat."
          : "Off: every approval waits for you."}
      </p>
      {note && (
        <Alert tone="error" role="status">
          {note}
        </Alert>
      )}
      {rules && rules.rules.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rules.rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              enabled={rules.enabled}
              busy={busy}
              onRemove={() =>
                void save({
                  enabled: rules.enabled,
                  rules: rules.rules.filter((r) => r.id !== rule.id),
                })
              }
            />
          ))}
        </ul>
      )}
      {rules &&
        (adding ? (
          <AddRule
            rules={rules.rules}
            busy={busy}
            onCancel={() => setAdding(false)}
            onAdd={(rule) =>
              void save({ enabled: rules.enabled, rules: [...rules.rules, rule] }).then(
                (saved) => saved && setAdding(false),
              )
            }
          />
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => setAdding(true)}
          >
            <Icon name="new" size={14} />
            Add a rule
          </Button>
        ))}
      <p className="m-0 flex gap-2 text-[12px] leading-[1.45] text-dim-foreground">
        <span className="mt-px flex-none" aria-hidden="true">
          <Icon name="shield" size={14} />
        </span>
        {ALWAYS_YOURS}
      </p>
      {recent.length > 0 && (
        <section className="flex flex-col gap-1.5" aria-label="Answered by rules">
          <h3 className={LABEL}>Answered by rules</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {recent.map((answer) => (
              <li
                key={`${answer.at}-${answer.id}-${answer.what}`}
                className="flex flex-col border-l-[3px] border-l-main pl-2.5 text-[13px]"
              >
                <span className="text-foreground">Approved {answer.what}</span>
                <span className="truncate font-mono text-[11px] text-dim-foreground">
                  {answer.title ?? answer.id.slice(0, 8)} · {ago(answer.at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
