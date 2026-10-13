/**
 * The choices of a model picker: routing class references first, then the models of each
 * provider, providers without a key or login last. Pure, so the terminal UI, the headless CLI and
 * the desktop app group and filter the same way.
 */

export interface CatalogModel {
  /** The `provider/model` ID a route names. */
  id: string;
  name: string;
  contextWindow?: number;
  /** Reasoning efforts a chat can pick for this model, lowest first; absent when it takes none. */
  efforts?: string[];
  /** Context windows in tokens a chat can pick for this model, smallest first; absent for one. */
  contextSizes?: number[];
}

/** One provider as `GET /v1/models` returns it. */
export interface CatalogProvider {
  id: string;
  name: string;
  /** Whether a key or login is available; a provider without one lists no models. */
  configured: boolean;
  models: CatalogModel[];
  error?: string;
}

export interface ModelCatalog {
  providers: CatalogProvider[];
}

export interface ModelChoice {
  /** What the field receives: `$name` or `provider/model`. */
  id: string;
  label: string;
  /** A short detail: the context window of a model, what a class resolves to. */
  detail?: string;
}

export interface ModelChoiceGroup {
  /** `classes` or the provider ID. */
  id: string;
  title: string;
  /** False for a provider without a key or login, or one whose model list failed. */
  available: boolean;
  /** Why the group has no choices: no key or login, or the provider's error. */
  note?: string;
  choices: ModelChoice[];
}

export interface ModelChoiceOptions {
  /** Class names without `$`, offered first; leave empty where only a model fits. */
  classes?: readonly string[];
  /** What each class resolves to, shown as its detail. */
  classDetails?: Readonly<Record<string, string>>;
  /** Case-insensitive words that every shown choice contains in its ID or name. */
  query?: string;
}

/** The note shown for a provider that lists no models. */
export const NO_LOGIN_NOTE = "no key or login";

export function formatContext(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function matcher(query: string | undefined): (...texts: string[]) => boolean {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return () => true;
  return (...texts) => {
    const hay = texts.join(" ").toLowerCase();
    return words.every((word) => hay.includes(word));
  };
}

/**
 * Groups a catalog for a picker. With a query, groups without a matching choice are left out,
 * except a provider without a key or login whose own name matches, so the reason stays visible.
 */
export function modelChoiceGroups(
  catalog: ModelCatalog,
  options: ModelChoiceOptions = {},
): ModelChoiceGroup[] {
  const matches = matcher(options.query);
  const filtering = Boolean(options.query?.trim());
  const groups: ModelChoiceGroup[] = [];
  const classes = (options.classes ?? [])
    .map((name) => {
      const detail = options.classDetails?.[name];
      return { id: `$${name}`, label: `$${name}`, ...(detail ? { detail } : {}) };
    })
    .filter((choice) => matches(choice.id, choice.detail ?? ""));
  if (classes.length)
    groups.push({ id: "classes", title: "Model names", available: true, choices: classes });
  const ready: ModelChoiceGroup[] = [];
  const missing: ModelChoiceGroup[] = [];
  for (const provider of catalog.providers) {
    const choices = provider.models
      .filter((m) => matches(m.id, m.name, provider.name))
      .map((m) => {
        const detail = formatContext(m.contextWindow);
        return { id: m.id, label: m.name || m.id, ...(detail ? { detail } : {}) };
      });
    const usable = provider.configured && provider.models.length > 0;
    if (usable) {
      if (choices.length || !filtering)
        ready.push({ id: provider.id, title: provider.name, available: true, choices });
      continue;
    }
    if (filtering && !matches(provider.id, provider.name)) continue;
    missing.push({
      id: provider.id,
      title: provider.name,
      available: false,
      note: provider.configured ? (provider.error ?? "no models listed") : NO_LOGIN_NOTE,
      choices: [],
    });
  }
  return [...groups, ...ready, ...missing];
}

/** Every choice of the groups, in order, for keyboard navigation. */
export function flatChoices(groups: readonly ModelChoiceGroup[]): ModelChoice[] {
  return groups.flatMap((group) => group.choices);
}
