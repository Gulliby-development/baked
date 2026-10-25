import { basename } from "node:path";
import type { Spec } from "../schemas.js";
import type { InitiativePlan } from "./plan.js";

/**
 * Wording that makes a clause depend on a later need: "if encoding needs ...", "any needed ...",
 * "as needed", "if required" (#2135).
 */
const CONDITIONAL =
  /\b(?:if\b[^.;]*\b(?:needs?|needed|requires?|required|necessary)\b|any needed\b|as needed\b|when needed\b|if (?:necessary|required)\b)/i;
/** A sentence of a contract: it ends at `.`, `;` or `!` before a space, or at a line break. */
const SENTENCES = /[^.;!\n]+(?:[.;!](?=\s|$)|$)/g;

/** A glob in a boundary (`src/**`) names no one file. plan.ts imports this module, so it is not imported back. */
const isGlob = (path: string) => /[*?[\]{}]/.test(path);

/** The names a feature is known by in another feature's text: its id and its files' stems. */
function featureNames(feature: InitiativePlan["features"][number]): string[] {
  const stems = feature.boundary.paths
    .filter((path) => !isGlob(path))
    .map((path) => basename(path).replace(/\.[^.]+$/, ""));
  return [feature.id, ...stems].filter((name) => name.length >= 3);
}

const wordIn = (text: string, word: string) =>
  new RegExp(
    `(?<![A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`,
    "i",
  ).test(text);

/**
 * Contract clauses that make another feature's work conditional on a need nobody decides (#2135).
 * R68 ewvet: reader's contract said "If encoding needs auxiliary syntax classification, keep it in
 * a public Reader helper ... exposed through Scan", scanner's "Expose any needed Reader-backed
 * encoding token classification through Scan". reader found no need and shipped no helper;
 * scanner, planned ahead, made the helper a `must` and spent 4.5M tokens on a symbol upstream did
 * not have. Each problem names the change the decomposer can make.
 */
export function conditionalContractProblems(plan: InitiativePlan): string[] {
  const problems: string[] = [];
  for (const feature of plan.features) {
    const others = plan.features.filter((other) => other.id !== feature.id);
    for (const match of feature.contract.matchAll(SENTENCES)) {
      const sentence = match[0].trim();
      if (!CONDITIONAL.test(sentence)) continue;
      const named = others.filter((other) =>
        featureNames(other).some((name) => wordIn(sentence, name)),
      );
      if (!named.length) continue;
      problems.push(
        `${feature.id}'s contract makes work across features conditional ("${sentence}", naming ${named.map((other) => other.id).join(", ")}): no feature decides whether it is needed. State it as a requirement of the one feature that owns it, with the symbol and when it is required, or remove the clause.`,
      );
    }
  }
  return problems;
}

/**
 * The files whose accepted text holds a released feature's upstream symbols: the paths its
 * dependencies list that no other feature lists, each with the dependency planned last that lists
 * it. A path the released feature, a feature planned after it or any other non-dependency also
 * lists is that feature's code, whoever owns its stub: R69 ewvet's base folded the skeleton, so its boundary listed all 27 stub files, and 6 of 7
 * released features recorded a would-stop for the members they write themselves (`Base64.Decode`
 * of bytes, #2192).
 */
export function upstreamFiles(
  plan: InitiativePlan,
  feature: InitiativePlan["features"][number],
): { featureId: string; path: string }[] {
  const upstream = plan.features.filter((f) => feature.dependsOn.includes(f.id));
  const elsewhere = new Set(
    plan.features.filter((f) => !feature.dependsOn.includes(f.id)).flatMap((f) => f.boundary.paths),
  );
  // A path several dependencies list (a stub and its filler) belongs to the one planned last, the
  // filler, so a gap names the feature that wrote the member.
  const owners = new Map<string, string>();
  for (const f of upstream)
    for (const path of f.boundary.paths)
      if (!isGlob(path) && !elsewhere.has(path)) owners.set(path, f.id);
  return [...owners].map(([path, featureId]) => ({ featureId, path }));
}

/** A symbol of an upstream feature that a downstream spec names and the accepted code lacks. */
export interface UpstreamSymbolGap {
  /** The requirement or criterion that names it. */
  ref: string;
  /** `Reader.IsEncodingToken`, or the helper phrase when the spec names no member. */
  symbol: string;
  featureId: string;
  path: string;
}

/** `Type.Member` in prose. */
const MEMBER = /\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
/** "a public Reader helper", "Reader's public helper": a helper of a type, with no member named. */
const HELPER = /\b(?:public\s+)?([A-Z][A-Za-z0-9_]*)(?:'s)?\s+(?:public\s+)?helper\b/g;

const typeOf = (path: string) =>
  basename(path)
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]/g, "")
    .toLowerCase();

/**
 * The members a planned-ahead spec names on the files of its upstream features that the accepted
 * upstream code does not define (#2135). A type is matched to a file by its stem in any letter
 * case (`Reader` to `Reader.cs`, `reader.go`, `reader.py`), so it works in every language; a
 * member is looked up as a word in that file. A helper the spec names by its type alone is a gap
 * too: nothing upstream decided it exists. `upstream` holds each upstream boundary file and its
 * text at the release base, null when absent.
 */
export function upstreamSymbolGaps(
  spec: Pick<Spec, "requirements" | "criteria">,
  upstream: readonly { featureId: string; path: string; text: string | null }[],
): UpstreamSymbolGap[] {
  const gaps: UpstreamSymbolGap[] = [];
  const seen = new Set<string>();
  const texts = [
    ...spec.requirements.map((r) => ({ ref: r.id, text: r.text })),
    ...spec.criteria.map((c) => ({ ref: c.id, text: `${c.given}\n${c.when}\n${c.then}` })),
  ];
  for (const { ref, text } of texts) {
    const named = new Set<string>();
    for (const [, type = "", member = ""] of text.matchAll(MEMBER)) {
      const files = upstream.filter((file) => typeOf(file.path) === type.toLowerCase());
      // `Reader.cs` is a file name, not a member.
      if (!files.length || files.some((file) => file.path.endsWith(`.${member}`))) continue;
      named.add(type.toLowerCase());
      if (files.some((file) => file.text !== null && wordIn(file.text, member))) continue;
      const symbol = `${type}.${member}`;
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      const file = files[0];
      if (file) gaps.push({ ref, symbol, featureId: file.featureId, path: file.path });
    }
    for (const match of text.matchAll(HELPER)) {
      const type = match[1] ?? "";
      const file = upstream.find((f) => typeOf(f.path) === type.toLowerCase());
      if (!file || named.has(type.toLowerCase()) || seen.has(match[0])) continue;
      seen.add(match[0]);
      gaps.push({ ref, symbol: match[0], featureId: file.featureId, path: file.path });
    }
  }
  return gaps;
}
