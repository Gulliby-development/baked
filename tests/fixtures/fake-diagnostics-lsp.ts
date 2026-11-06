/**
 * A minimal language server for tests. A document that contains `use(NAME)` has an error unless an
 * open document contains `export function NAME`. After every open or change it publishes the
 * diagnostics of all open documents, as real servers do for files that import a changed one.
 *
 * With `--workspace` it also publishes for the `.ts` files on disk in the root that are not open,
 * as workspace-wide servers (gopls, rust-analyzer, pyright in workspace mode) do, 200 ms after each
 * open or change.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { filePathToUri, uriToFilePath } from "../../src/core/intelligence/backends/lsp/protocol.js";

const workspace = process.argv.includes("--workspace");
const publishDelayMs = workspace ? 200 : 20;
let root = "";
const docs = new Map<string, string>();
let buffer = Buffer.alloc(0);

function send(message: Record<string, unknown>): void {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`);
}

function workspaceDocs(): Map<string, string> {
  const all = new Map(docs);
  if (!workspace || !root) return all;
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".ts")) continue;
    const uri = filePathToUri(join(root, name));
    if (!all.has(uri)) all.set(uri, readFileSync(join(root, name), "utf-8"));
  }
  return all;
}

function publishAll(): void {
  const all = workspaceDocs();
  const exported = new Set<string>();
  for (const text of all.values())
    for (const m of text.matchAll(/export function (\w+)/g)) exported.add(m[1] as string);
  for (const [uri, text] of all) {
    const diagnostics = text
      .split("\n")
      .flatMap((line, i) =>
        [...line.matchAll(/use\((\w+)\)/g)]
          .filter((m) => !exported.has(m[1] as string))
          .map((m) => ({
            range: {
              start: { line: i, character: m.index ?? 0 },
              end: { line: i, character: (m.index ?? 0) + m[0].length },
            },
            severity: 1,
            code: 2305,
            message: `Module has no exported member '${m[1] as string}'.`,
          })),
      );
    send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  }
}

function handle(msg: {
  id?: number;
  method?: string;
  params?: {
    rootUri?: string;
    textDocument?: { uri: string; text?: string };
    contentChanges?: { text: string }[];
  };
}): void {
  switch (msg.method) {
    case "initialize":
      root = msg.params?.rootUri ? uriToFilePath(msg.params.rootUri) : "";
      send({ id: msg.id, result: { capabilities: {} } });
      return;
    case "shutdown":
      send({ id: msg.id, result: null });
      return;
    case "exit":
      process.exit(0);
      return;
    case "textDocument/didOpen":
      docs.set(msg.params?.textDocument?.uri ?? "", msg.params?.textDocument?.text ?? "");
      setTimeout(publishAll, publishDelayMs);
      return;
    case "textDocument/didChange":
      docs.set(msg.params?.textDocument?.uri ?? "", msg.params?.contentChanges?.[0]?.text ?? "");
      setTimeout(publishAll, publishDelayMs);
      return;
    default:
      if (msg.id !== undefined) send({ id: msg.id, result: null });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf("\r\n\r\n");
    if (header < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())?.[1]);
    if (buffer.length < header + 4 + length) return;
    const body = buffer.subarray(header + 4, header + 4 + length).toString();
    buffer = buffer.subarray(header + 4 + length);
    handle(JSON.parse(body));
  }
});
