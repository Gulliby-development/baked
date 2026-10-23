import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * The line framing of a provider subprocess's JSON Lines output (#1956): `codex exec --json`,
 * the `codex app-server` JSON-RPC stream and Claude Code's `stream-json` end a message at `\n`
 * only. `node:readline` also ends a line at U+2028 and U+2029, which JSON carries raw inside a
 * string (Codex's `serde_json` writes them unescaped), so it cut answers and tool calls that held
 * one into halves that did not parse. Bytes are decoded with a `StringDecoder`, so a chunk that
 * ends inside a multibyte character is completed by the next one; a trailing `\r` is dropped.
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private rest = "";

  push(chunk: Buffer | string): string[] {
    this.rest += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines = this.rest.split("\n");
    this.rest = lines.pop() ?? "";
    return lines.map(withoutCr);
  }

  end(): string[] {
    const last = this.rest + this.decoder.end();
    this.rest = "";
    return last ? [withoutCr(last)] : [];
  }
}

const withoutCr = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** Calls `onLine` for each line of `stream`; the returned function stops listening. */
export function onJsonLines(stream: Readable, onLine: (line: string) => void): () => void {
  const splitter = new LineSplitter();
  const data = (chunk: Buffer | string) => {
    for (const line of splitter.push(chunk)) onLine(line);
  };
  const end = () => {
    for (const line of splitter.end()) onLine(line);
  };
  stream.on("data", data);
  stream.once("end", end);
  return () => {
    stream.off("data", data);
    stream.off("end", end);
  };
}

/** The lines of `stream` until it ends. */
export async function* jsonLines(stream: Readable): AsyncGenerator<string> {
  const splitter = new LineSplitter();
  for await (const chunk of stream) yield* splitter.push(chunk as Buffer | string);
  yield* splitter.end();
}

const SAMPLES = 3;
const SAMPLE_CHARS = 200;

/**
 * The lines of a provider stream that did not parse as JSON, so a reader never drops one without
 * a trace: an error for a call that ended with no answer names them (`note`).
 */
export class UnparsedLines {
  count = 0;
  readonly samples: string[] = [];

  /** The parsed line, or undefined after recording it as unparsed. */
  parse<T>(line: string): T | undefined {
    try {
      return JSON.parse(line) as T;
    } catch {
      this.count += 1;
      if (this.samples.length < SAMPLES) this.samples.push(line.slice(0, SAMPLE_CHARS));
      return undefined;
    }
  }

  /** What to add to an error after `since` lines had been counted, or "" when none followed. */
  note(since = 0): string {
    const count = this.count - since;
    if (count <= 0) return "";
    return `; ${count} output line(s) did not parse: ${this.samples.map((s) => JSON.stringify(s)).join(", ")}`;
  }
}
