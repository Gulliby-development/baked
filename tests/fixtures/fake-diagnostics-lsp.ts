/**
 * A minimal language server for tests. A document that contains `use(NAME)` has an error unless an
 * open document contains `export function NAME`. After every open or change it publishes the
 * diagnostics of all open documents, as real servers do for files that import a changed one.
 */
const docs = new Map<string, string>();
let buffer = Buffer.alloc(0);

function send(message: Record<string, unknown>): void {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`);
}

function publishAll(): void {
  const exported = new Set<string>();
  for (const text of docs.values())
    for (const m of text.matchAll(/export function (\w+)/g)) exported.add(m[1] as string);
  for (const [uri, text] of docs) {
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
    textDocument?: { uri: string; text?: string };
    contentChanges?: { text: string }[];
  };
}): void {
  switch (msg.method) {
    case "initialize":
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
      setTimeout(publishAll, 20);
      return;
    case "textDocument/didChange":
      docs.set(msg.params?.textDocument?.uri ?? "", msg.params?.contentChanges?.[0]?.text ?? "");
      setTimeout(publishAll, 20);
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
