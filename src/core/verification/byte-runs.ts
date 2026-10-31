/**
 * Long byte runs compared by their counts (#2515). A prescribed row or criterion literal can give
 * a long input as a repeated byte: a hex string (`"7878…78"`, 600 digits for 300 bytes), a byte
 * list (`0x78, 0x78, …`), an escaped byte string (`b"\x78\x78…"`) or a repeat expression
 * (`"78" * 300`, `vec![0x78; 300]`). A verbatim lookup holds 300 bytes inside 303, and a test that
 * spells the run in another notation is never matched as a whole. Bench round 82: tinyflate (C)
 * deflate T007 wrote `tests/deflate_match_test.c` with 303 bytes of `0x78` where the brief
 * prescribes 300 and 238 bytes of `0x71` where it prescribes 259; no host check named the
 * miscount, the failing check read as a source failure, and every corrective rewrote a correct
 * `src/deflate.c` until the run ended `invalid_output`.
 *
 * Both sides are read as spans of (byte, count) runs, one span per expression on a line (its terms
 * joined by a concatenation operator, or adjacent strings as C joins them), and a prescribed span
 * with a run of `LONG_RUN` bytes or more is held only by a file span with the same bytes and the
 * same long counts. One with the same bytes and a long count changed is a drift, by the bytes it
 * differs. `verbatimHeld` and `testsHold` (criteria-cases.ts), `misquotation` (conflict-rows.ts)
 * and `measureRows` (row-block-drift.ts) all decide a long run through `runLengthCompare`.
 *
 * Notations read, on both sides: hex strings (any quote), escaped byte strings (`\xHH`, a `b`
 * prefix), lists of `0xHH` (C, C++, Go, Rust, Java, C#, TypeScript, Python, Elixir `<<…>>`), and
 * repeats: `U * N` and `N * U` (Python, Ruby, the brief's `0x78 × 300`), `U.repeat(N)`
 * (TypeScript, JavaScript, Rust), `strings.Repeat`/`bytes.Repeat` (Go), `String.duplicate`,
 * `:binary.copy`, `List.duplicate` (Elixir), `vec![U; N]`/`[U; N]` (Rust), `Buffer.alloc(N, U)`,
 * `new Uint8Array(N).fill(U)`, `Array(N).fill(U)` (TypeScript), `memset(p, U, N)` (C, C++), and the
 * prose `N bytes of 0xHH`, `0xHH repeated N times`.
 */

/** One byte value, `count` times in a row. */
export interface ByteRun {
  byte: number;
  count: number;
}

/** A byte sequence one expression of a text spells, with the ways it may be read. */
export interface RunSpan {
  /** The line it is on, from 1. */
  line: number;
  /** Its source text, as the text spells it. */
  spelling: string;
  /** Each reading of it (a hex string `"aa"` is one byte; read as text, two). */
  readings: ByteRun[][];
}

/** One long run a file span counts differently. */
export interface RunDiff {
  byte: number;
  prescribed: number;
  found: number;
}

/** A prescribed span the file spells with a long run's count changed. */
export interface RunDrift {
  /** The file line of the span, from 1. */
  line: number;
  /** The file's spelling of it. */
  spelling: string;
  /** The runs counted differently, in order. */
  diffs: RunDiff[];
  /** How many bytes the file's span differs by: the sum of the count differences. */
  bytes: number;
}

/** The comparison of a prescribed text's long runs with a file. */
export interface RunComparison {
  /** Spans of the prescribed text with a long run. */
  spans: number;
  /** Of them, those a file span holds with every count as given. */
  held: number;
  /** Of the others, the nearest file span with the same bytes and a long count changed. */
  drifts: RunDrift[];
}

/** A run this long is a run: shorter repeats are ordinary text. */
export const LONG_RUN = 16;
const MAX_COUNT = 10_000_000;
const MAX_READINGS = 4;

const H = String.raw`(?:\(\s*(?:byte|u?int8_t|unsigned\s+char|char|u8)\s*\)\s*)?0x[0-9a-fA-F]{1,2}(?:_?u8|_?i8|[uU])?(?:\.toByte\(\))?(?![0-9a-fA-F])`;
const DQ = String.raw`"(?:\\.|[^"\\\n])*"`;
const SQ = String.raw`'(?:\\.|[^'\\\n])*'`;
const STR = `(?:b|br|rb|B)?(?:${DQ}|${SQ})`;
const N = String.raw`\d[\d_]*`;
// A repeat's unit: a string, one hex byte, or one byte in a list, a Go slice or an Elixir binary.
const U = String.raw`(?:${STR}|bytes\(\s*\[\s*${H}\s*\]\s*\)|\[\]byte\{\s*${H}\s*\}|\[\]byte\(\s*${DQ}\s*\)|<<\s*(?:${H}|${DQ})\s*>>|\[\s*${H}\s*\]|${H})`;
const OP = String.raw`\s*(?:\*|×|x(?=\s)|times(?=\s))\s*`;

/** Every repeat notation: the unit and the count as named groups. */
const REPEATS: RegExp[] = [
  String.raw`(?<u>${U})${OP}(?<n>${N})(?![\w.])`,
  String.raw`(?<![\w.])(?<n>${N})${OP}(?<u>${U})`,
  String.raw`(?<u>${U})\.repeat\(\s*(?<n>${N})\s*\)`,
  String.raw`(?:strings|bytes)\.Repeat\(\s*(?<u>${U})\s*,\s*(?<n>${N})\s*\)`,
  String.raw`(?:String\.duplicate|:binary\.copy|List\.duplicate)\(\s*(?<u>${U})\s*,\s*(?<n>${N})\s*\)`,
  String.raw`(?:vec!)?\[\s*(?<u>${H})\s*;\s*(?<n>${N})\s*\]`,
  String.raw`Buffer\.alloc\(\s*(?<n>${N})\s*,\s*(?<u>${H})\s*\)`,
  String.raw`(?:new\s+)?(?:Uint8Array|Array)\(\s*(?<n>${N})\s*\)\.fill\(\s*(?<u>${H})\s*\)`,
  String.raw`memset\(\s*[^,()]+,\s*(?<u>${H})\s*,\s*(?<n>${N})\s*\)`,
  String.raw`(?<![\w.])(?<n>${N})\s+bytes\s+of\s+(?<u>${H})`,
  String.raw`(?<u>${H})\s+repeated\s+(?<n>${N})\s+times`,
].map((source) => new RegExp(source, "g"));
const BYTE_LIST = new RegExp(String.raw`(?<![\w.])${H}(?:\s*,\s*${H})*`, "g");
const STRING = new RegExp(STR, "g");
const HEX_NUMBER = /0x([0-9a-fA-F]{1,2})(?![0-9a-fA-F])/g;
/** What may stand between two terms of one span: brackets and one concatenation operator. */
const JOIN = /^[\s\])}>]*(?:\+\+?|<>|\.\.|\|\|)?[\s[({<]*$/;

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };

/** A string body with its escapes decoded: `\xHH`, octal `\ooo`, `\n` and the like. */
function decoded(body: string): string {
  return body.replace(
    /\\(?:x([0-9a-fA-F]{2})|([0-3][0-7]{2})|(.))/g,
    (_, hex: string | undefined, octal: string | undefined, simple: string) =>
      hex !== undefined
        ? String.fromCharCode(Number.parseInt(hex, 16))
        : octal !== undefined
          ? String.fromCharCode(Number.parseInt(octal, 8))
          : (SIMPLE_ESCAPES[simple] ?? simple),
  );
}

/** Runs of a byte sequence, equal neighbours merged. */
function runsOf(bytes: Iterable<number>): ByteRun[] {
  const runs: ByteRun[] = [];
  for (const byte of bytes) {
    const last = runs.at(-1);
    if (last?.byte === byte) last.count++;
    else runs.push({ byte, count: 1 });
  }
  return runs;
}

/** Two run sequences one after the other. */
function joined(a: readonly ByteRun[], b: readonly ByteRun[]): ByteRun[] {
  const out = a.map((r) => ({ ...r }));
  for (const run of b) {
    const last = out.at(-1);
    if (last?.byte === run.byte) last.count += run.count;
    else out.push({ ...run });
  }
  return out;
}

const longRun = (runs: readonly ByteRun[]) => runs.some((r) => r.count >= LONG_RUN);

/**
 * The readings of a string term: a hex string as its bytes; an escaped byte string (`\xHH`, or a
 * `b` prefix) as its characters; and, for a repeat's unit, its characters too (`"x" * 300`).
 */
function stringReadings(term: string, unit: boolean): ByteRun[][] {
  const m = /^(b|br|rb|B)?(["'])([\s\S]*)\2$/.exec(term);
  if (!m) return [];
  const prefix = m[1] ?? "";
  const body = m[3] ?? "";
  const readings: ByteRun[][] = [];
  if (!prefix && body.length >= 2 && /^(?:[0-9a-fA-F]{2})+$/.test(body)) {
    const bytes: number[] = [];
    for (let i = 0; i < body.length; i += 2) bytes.push(Number.parseInt(body.slice(i, i + 2), 16));
    readings.push(runsOf(bytes));
  }
  if (unit || prefix || /\\x[0-9a-fA-F]{2}/.test(body)) {
    const text = prefix.includes("r") ? body : decoded(body);
    const codes = [...text].map((ch) => ch.codePointAt(0) ?? 0);
    if (codes.length && codes.every((c) => c <= 0xff)) readings.push(runsOf(codes));
  }
  return readings;
}

/** The readings of a repeat's unit. */
function unitReadings(unit: string): ByteRun[][] {
  const quoted = new RegExp(`^${STR}$`).test(unit.trim()) ? unit.trim() : null;
  if (quoted) return stringReadings(quoted, true);
  const inner = new RegExp(`(?:b|br|rb|B)?${DQ}`).exec(unit)?.[0];
  if (inner) return stringReadings(inner, true);
  const hex = [...unit.matchAll(HEX_NUMBER)].map((h) => Number.parseInt(h[1] ?? "0", 16));
  return hex.length === 1 ? [runsOf(hex)] : [];
}

/** A one-run unit `n` times. */
const times = (runs: readonly ByteRun[], n: number): ByteRun[] =>
  runs.map((r) => ({ byte: r.byte, count: r.count * n }));

interface Term {
  start: number;
  end: number;
  readings: ByteRun[][];
}

/** The byte terms of one line, left to right, none overlapping (the longest at a place wins). */
function lineTerms(line: string): Term[] {
  const found: Term[] = [];
  for (const re of REPEATS)
    for (const m of line.matchAll(re)) {
      const n = Number((m.groups?.n ?? "").replaceAll("_", ""));
      if (!Number.isSafeInteger(n) || n < 1 || n > MAX_COUNT) continue;
      // Only a one-byte unit repeats into a long run (`"78" * 300` read as text says nothing).
      const readings = unitReadings(m.groups?.u ?? "")
        .filter((r) => r.length === 1)
        .map((r) => times(r, n));
      if (readings.length) found.push({ start: m.index, end: m.index + m[0].length, readings });
    }
  for (const m of line.matchAll(BYTE_LIST)) {
    const bytes = [...m[0].matchAll(HEX_NUMBER)].map((h) => Number.parseInt(h[1] ?? "0", 16));
    found.push({ start: m.index, end: m.index + m[0].length, readings: [runsOf(bytes)] });
  }
  for (const m of line.matchAll(STRING)) {
    const readings = stringReadings(m[0], false);
    if (readings.length) found.push({ start: m.index, end: m.index + m[0].length, readings });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const terms: Term[] = [];
  for (const term of found) {
    const last = terms.at(-1);
    if (last && term.start < last.end) continue;
    terms.push(term);
  }
  return terms;
}

/** Every reading of two joined terms, at most `MAX_READINGS`. */
function product(a: ByteRun[][], b: ByteRun[][]): ByteRun[][] {
  return a.flatMap((x) => b.map((y) => joined(x, y))).slice(0, MAX_READINGS);
}

const spanCache = new Map<string, RunSpan[]>();

/** The spans of a text with a long run in some reading, line by line. */
export function runSpans(text: string): RunSpan[] {
  const cached = spanCache.get(text);
  if (cached) return cached;
  const spans: RunSpan[] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    // A line with no digit and no byte string spells no run: skip it cheaply.
    if (!/\d|b["']/.test(line)) continue;
    let open: (Term & { from: number }) | null = null;
    const close = () => {
      const readings = open?.readings.filter(longRun) ?? [];
      if (open && readings.length)
        spans.push({ line: i + 1, spelling: line.slice(open.from, open.end), readings });
    };
    for (const term of lineTerms(line)) {
      if (open && JOIN.test(line.slice(open.end, term.start))) {
        open = { ...term, from: open.from, readings: product(open.readings, term.readings) };
        continue;
      }
      close();
      open = { ...term, from: term.start };
    }
    close();
  }
  if (spanCache.size > 32) spanCache.clear();
  spanCache.set(text, spans);
  return spans;
}

/**
 * The spans of a prescribed text: its expressions, or, for a literal the request quoted (the
 * content of a row's string, a criterion's value), the literal itself read as a hex string
 * (`7878…`) or as spaced hex bytes (`78 78 …`).
 */
export function literalSpans(text: string): RunSpan[] {
  const spans = runSpans(text);
  if (spans.length) return spans;
  const bare = text.trim();
  const pairs = /^(?:[0-9a-fA-F]{2})+$/.test(bare)
    ? bare.match(/../g)
    : /^[0-9a-fA-F]{2}(?:[\s,]+[0-9a-fA-F]{2})+$/.test(bare)
      ? bare.split(/[\s,]+/)
      : null;
  const runs = pairs ? runsOf(pairs.map((p) => Number.parseInt(p, 16))) : [];
  return longRun(runs) ? [{ line: 1, spelling: bare, readings: [runs] }] : [];
}

/**
 * How a file's runs `f` stand to prescribed runs `p`: the long runs counted differently at the
 * best place `p` lines up in `f` (empty when it is held), or null when it lines up nowhere. Bytes
 * must be the same in order; a short run inside `p` must have its count; a short run at either
 * end may be longer in the file (the span goes on); a long run must have its count or is a diff.
 */
function fit(p: readonly ByteRun[], f: readonly ByteRun[]): RunDiff[] | null {
  let best: RunDiff[] | null = null;
  let bestBytes = Number.POSITIVE_INFINITY;
  for (let at = 0; at + p.length <= f.length; at++) {
    const diffs: RunDiff[] = [];
    let ok = true;
    for (const [i, want] of p.entries()) {
      const got = f[at + i];
      if (!got || got.byte !== want.byte) {
        ok = false;
        break;
      }
      if (got.count === want.count) continue;
      if (want.count >= LONG_RUN || got.count >= LONG_RUN) {
        diffs.push({ byte: want.byte, prescribed: want.count, found: got.count });
        continue;
      }
      const edge = i === 0 || i === p.length - 1;
      if (!(edge && want.count < got.count)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const bytes = diffs.reduce((n, d) => n + Math.abs(d.found - d.prescribed), 0);
    if (bytes < bestBytes) {
      best = diffs;
      bestBytes = bytes;
    }
    if (!bytes) break;
  }
  return best;
}

/**
 * The one comparison of a prescribed text's long byte runs with a file (#2515): for each span of
 * `prescribed` with a long run, whether a span of `file` holds it with every count as given, or
 * else the file span nearest to it (fewest bytes off) with the same bytes and a long count
 * changed. Null when `prescribed` spells no long run.
 */
export function runLengthCompare(file: string, prescribed: string): RunComparison | null {
  const wanted = literalSpans(prescribed);
  if (!wanted.length) return null;
  const spans = runSpans(file);
  const out: RunComparison = { spans: wanted.length, held: 0, drifts: [] };
  for (const span of wanted) {
    let held = false;
    let nearest: RunDrift | null = null;
    for (const fileSpan of spans) {
      for (const p of span.readings.filter(longRun))
        for (const f of fileSpan.readings) {
          const diffs = fit(p, f);
          if (!diffs) continue;
          if (!diffs.length) held = true;
          const bytes = diffs.reduce((n, d) => n + Math.abs(d.found - d.prescribed), 0);
          if (diffs.length && (!nearest || bytes < nearest.bytes))
            nearest = { line: fileSpan.line, spelling: fileSpan.spelling, diffs, bytes };
        }
      if (held) break;
    }
    if (held) out.held++;
    else if (nearest) out.drifts.push(nearest);
  }
  return out;
}

/**
 * Whether a file holds a literal's long runs: true when every span of it is held as given, false
 * when one is spelled with a long count changed, null when the literal spells no long run or a
 * span lines up with nothing in the file (another lookup decides).
 */
export function runsHeld(file: string, literal: string): boolean | null {
  const compared = runLengthCompare(file, literal);
  if (!compared) return null;
  if (compared.drifts.length) return false;
  return compared.held === compared.spans ? true : null;
}

const hexByte = (byte: number) => `0x${byte.toString(16).padStart(2, "0")}`;

/** A drift in the words a brief uses: `303 bytes of 0x78 where the row gives 300`. */
export function runDiffText(diff: RunDiff, where = "the row"): string {
  return `${diff.found} bytes of ${hexByte(diff.byte)} where ${where} gives ${diff.prescribed}`;
}

/**
 * The file's spelling `quoted` with its long runs counted as `literal` gives them, in the file's
 * own notation: a repeat's count rewritten, a hex string or a byte list written out again. Null
 * when the spelling is not one term the host can rewrite exactly.
 */
export function respelled(quoted: string, literal: string): string | null {
  const [span] = runSpans(quoted);
  const [want] = literalSpans(literal);
  if (!span || !want || runSpans(quoted).length !== 1) return null;
  const wanted = want.readings.find(longRun);
  if (!wanted) return null;
  const terms = lineTerms(span.spelling);
  if (terms.length !== 1) return null;
  const text = span.spelling;
  // A repeat: its unit is one byte, so its count is the run's.
  for (const re of REPEATS)
    for (const m of text.matchAll(re)) {
      if (m.index !== 0 || m[0].length !== text.length || wanted.length !== 1) continue;
      const count = String(wanted[0]?.count ?? 0);
      const n = m.groups?.n ?? "";
      const at = m[0].lastIndexOf(n);
      const unit = unitReadings(m.groups?.u ?? "");
      if (!unit.some((r) => r.length === 1 && r[0]?.count === 1 && r[0].byte === wanted[0]?.byte))
        continue;
      if (m[0].indexOf(n) !== at) return null;
      return `${text.slice(0, at)}${count}${text.slice(at + n.length)}`;
    }
  const bytes = wanted.flatMap((r) => Array.from({ length: r.count }, () => r.byte));
  const quote = /^(["'])(?:[0-9a-fA-F]{2})+\1$/.exec(text);
  if (quote) {
    const upper = /[A-F]/.test(text);
    const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${quote[1]}${upper ? hex.toUpperCase() : hex}${quote[1]}`;
  }
  const items = [...text.matchAll(new RegExp(H, "g"))];
  const first = items[0]?.[0];
  if (items.length >= 2 && first && items.every((i) => i[0].length === first.length)) {
    const separator = text.slice(first.length, items[1]?.index ?? first.length);
    const upper = /0x[0-9A-F]*[A-F]/.test(text);
    const item = (b: number) => {
      const digits = b.toString(16).padStart(2, "0");
      return first.replace(/0x[0-9a-fA-F]{1,2}/, `0x${upper ? digits.toUpperCase() : digits}`);
    };
    return bytes.map(item).join(separator);
  }
  return null;
}
