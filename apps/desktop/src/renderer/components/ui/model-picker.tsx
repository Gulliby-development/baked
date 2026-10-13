import { type KeyboardEvent, useId, useMemo, useState } from "react";
import {
  type ModelCatalog,
  type ModelChoice,
  modelChoiceGroups,
} from "../../../../../../src/core/llm/model-choices.js";
import { MODELS_READ } from "../../client/api.js";
import { cn } from "../../lib/cn.js";
import { useQuery } from "../../lib/query.js";
import { Button } from "./button.js";
import { Input } from "./input.js";

/**
 * The catalog of `GET /v1/models` for a project, read through the shared query cache so a screen
 * opened again lists the models at once; `error` when the backend refused. A null key reads nothing.
 */
export function useModelCatalog(
  projectKey: string | null,
  load: (projectKey: string) => Promise<ModelCatalog>,
): {
  catalog: ModelCatalog | null;
  error: string | null;
} {
  const query = useQuery(projectKey === null ? null : [projectKey, MODELS_READ], () =>
    load(projectKey ?? ""),
  );
  if (query.hasData) return { catalog: query.data ?? null, error: null };
  const { error } = query;
  return {
    catalog: null,
    error:
      query.loading || error === null
        ? null
        : error instanceof Error
          ? error.message
          : String(error),
  };
}

export interface ModelPickerProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Called when a listed model is chosen; without it, choosing sets the value. */
  onPick?: (id: string) => void;
  catalog: ModelCatalog | null;
  error?: string | null;
  /** Class names without `$`, listed first; leave empty where only a model fits. */
  classes?: readonly string[];
  classDetails?: Readonly<Record<string, string>>;
  placeholder?: string;
  disabled?: boolean;
  /** Enter on text that is no listed model: the fallback list adds it as typed. */
  onEnterText?: (text: string) => void;
}

/**
 * A model field: type a `provider/model` ID or `$class`, or open the list of available models,
 * grouped by provider with model names on top. Providers without a key or login are greyed out.
 * Typing filters the list; arrows and Enter choose, Escape closes it.
 */
export function ModelPicker({
  id,
  value,
  onChange,
  onPick,
  catalog,
  error,
  classes = [],
  classDetails,
  placeholder = "provider/model",
  disabled,
  onEnterText,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const groups = useMemo(
    () =>
      modelChoiceGroups(catalog ?? { providers: [] }, {
        classes,
        ...(classDetails ? { classDetails } : {}),
        query,
      }),
    [catalog, classes, classDetails, query],
  );
  const choices = groups.flatMap((g) => g.choices);
  const at = Math.min(active, Math.max(0, choices.length - 1));
  const choose = (choice: ModelChoice): void => {
    if (onPick) onPick(choice.id);
    else onChange(choice.id);
    setOpen(false);
    setQuery("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      if (choices.length)
        setActive((at + (event.key === "ArrowUp" ? choices.length - 1 : 1)) % choices.length);
      return;
    }
    if (event.key === "Escape" && open) {
      // Closes the list, not the dialog around it.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "Enter") {
      const choice = open ? choices[at] : undefined;
      if (choice) {
        event.preventDefault();
        choose(choice);
      } else if (onEnterText && value.trim()) {
        event.preventDefault();
        onEnterText(value.trim());
        setOpen(false);
        setQuery("");
      }
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          id={id}
          className="font-mono"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && choices[at] ? `${listId}-${at}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            onChange(e.target.value);
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setOpen(false)}
        />
        <Button
          type="button"
          variant="neutral"
          className="shrink-0 px-3"
          disabled={disabled}
          aria-label={open ? "Hide models" : "Show models"}
          aria-expanded={open}
          // Keeps the focus in the field, so its blur does not close the list first.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery("");
            // Opens on the current model, so arrows move from it.
            const all = modelChoiceGroups(catalog ?? { providers: [] }, {
              classes,
              ...(classDetails ? { classDetails } : {}),
            }).flatMap((g) => g.choices);
            setActive(
              Math.max(
                0,
                all.findIndex((c) => c.id === value.trim()),
              ),
            );
            setOpen((v) => !v);
            document.getElementById(id)?.focus();
          }}
        >
          Models ▾
        </Button>
      </div>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Models"
          className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-base border-2 border-border bg-raised p-2 text-[13px]"
          onMouseDown={(e) => e.preventDefault()}
        >
          {error && <p className="m-1 text-[12px] text-[var(--err)]">{error}</p>}
          {!error && !catalog && (
            <p className="m-1 text-[12px] text-dim-foreground">Asking the providers for models…</p>
          )}
          {catalog && groups.length === 0 && (
            <p className="m-1 text-[12px] text-dim-foreground">
              {onEnterText
                ? "No listed model matches; Enter adds the ID as typed."
                : "No listed model matches; the field keeps the ID as typed."}
            </p>
          )}
          {groups.map((group) => (
            <fieldset key={group.id} className="m-0 flex min-w-0 flex-col border-0 p-0">
              <legend
                className={cn(
                  "flex items-baseline gap-2 px-1 pt-1 pb-[2px] font-mono text-[11px] font-bold tracking-[0.08em] uppercase",
                  group.available ? "text-dim-foreground" : "text-muted-foreground opacity-60",
                )}
              >
                {group.title}
                {group.note && (
                  <span className="font-sans font-normal tracking-normal normal-case">
                    {group.note}
                    {!group.available && " · Settings > Providers"}
                  </span>
                )}
              </legend>
              {group.choices.map((choice) => {
                const index = choices.indexOf(choice);
                return (
                  <div
                    key={choice.id}
                    id={`${listId}-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === at}
                    className={cn(
                      "flex min-h-[30px] cursor-pointer items-center gap-2 rounded-base border-2 border-transparent px-2 py-1 text-soft-foreground hover:bg-hover hover:text-foreground",
                      index === at && "border-border bg-selected text-foreground",
                    )}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(choice)}
                    onKeyDown={() => undefined}
                  >
                    <span className="shrink-0 font-mono">{choice.id}</span>
                    {choice.label !== choice.id && (
                      <span className="min-w-0 shrink-[3] truncate text-dim-foreground">
                        {choice.label}
                      </span>
                    )}
                    {choice.detail && (
                      <span className="ml-auto min-w-0 truncate font-mono text-[12px] text-dim-foreground">
                        {choice.detail}
                      </span>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Up to `max` fallback models: the chosen ones as removable chips, and a model field that adds
 * the model chosen from the list, or the typed ID on Enter.
 */
export function ModelListPicker({
  id,
  value,
  onChange,
  catalog,
  error,
  max = 3,
  disabled,
}: {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
  catalog: ModelCatalog | null;
  error?: string | null;
  max?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const add = (model: string): void => {
    if (!value.includes(model)) onChange([...value, model].slice(0, max));
    setText("");
  };
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ol className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Fallback models">
          {value.map((model, i) => (
            <li
              key={model}
              className="inline-flex items-center gap-1 rounded-base border-2 border-border bg-secondary-background py-[2px] pr-1 pl-2 font-mono text-[12px]"
            >
              <span className="text-dim-foreground">{i + 1}.</span>
              {model}
              <button
                type="button"
                className="ml-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-base border-0 bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground"
                aria-label={`Remove ${model}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((m) => m !== model))}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      {value.length < max ? (
        <ModelPicker
          id={id}
          value={text}
          onChange={setText}
          onPick={add}
          onEnterText={add}
          catalog={catalog}
          error={error ?? null}
          placeholder={value.length ? "add another" : "none"}
          {...(disabled ? { disabled } : {})}
        />
      ) : (
        <span className="text-[12px] text-dim-foreground">
          {max} fallback models; remove one to add another.
        </span>
      )}
    </div>
  );
}
