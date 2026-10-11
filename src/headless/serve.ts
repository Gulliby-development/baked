import { resolve } from "node:path";
import { loadConfig, loadProjectConfig, mergeConfigs } from "../config/index.js";
import { startApiServer } from "../core/api/server.js";
import { getCwd } from "../core/cwd.js";
import { scaffoldProjectQuietly } from "../core/projects/scaffold.js";
import { NativeWorkflowService } from "../core/workflows/service.js";

export const serveHelp = `baked serve [--port N] [--token-file FILE] [--allow-origin ORIGIN]... [--cwd DIR]

Serves the local workflow API on 127.0.0.1 for desktop apps and other clients.
  --port N              port to bind; 0 (default) picks a free port
  --token-file FILE     where to write the bearer token (mode 0600);
                        default .baked/serve-PORT.token in the workspace
  --allow-origin ORIGIN accept browser requests from this exact origin (repeatable)

Prints one JSON line {"url","port","tokenFile"} when ready. Every request needs
"Authorization: Bearer TOKEN". Stops on SIGINT or SIGTERM and removes the token file.
`;

export interface ServeArgs {
  port: number;
  tokenFile?: string;
  allowOrigins: string[];
}

export function parseServeArgs(argv: string[]): ServeArgs | "help" {
  const result: ServeArgs = { port: 0, allowOrigins: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") return "help";
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${token} needs a value`);
      return next;
    };
    if (token === "--port") {
      const raw = value();
      const port = Number(raw);
      if (!/^\d+$/.test(raw) || port > 65535)
        throw new Error("--port requires an integer from 0 to 65535");
      result.port = port;
    } else if (token === "--token-file") {
      if (result.tokenFile !== undefined) throw new Error("Duplicate option --token-file");
      result.tokenFile = value();
    } else if (token === "--allow-origin") result.allowOrigins.push(value());
    else if (token === "--cwd") value();
    else if (token?.startsWith("--cwd=")) continue;
    else throw new Error(`Unknown option ${token ?? ""}`);
  }
  return result;
}

export async function runServeCli(argv: string[]): Promise<number> {
  let args: ServeArgs | "help";
  try {
    args = parseServeArgs(argv);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ code: "INVALID_ARGUMENT", message: error instanceof Error ? error.message : String(error) })}\n`,
    );
    return 1;
  }
  if (args === "help") {
    process.stdout.write(serveHelp);
    return 0;
  }
  const cwd = getCwd();
  // The desktop app opens a project by serving its folder, so the folder is set up here.
  scaffoldProjectQuietly(cwd);
  const config = mergeConfigs(loadConfig(), loadProjectConfig(cwd));
  const service = new NativeWorkflowService(cwd, config);
  let server: Awaited<ReturnType<typeof startApiServer>>;
  try {
    server = await startApiServer({
      service,
      port: args.port,
      allowOrigins: args.allowOrigins,
      ownsService: true,
      ...(args.tokenFile ? { tokenFile: resolve(cwd, args.tokenFile) } : {}),
    });
  } catch (error) {
    service.close();
    process.stderr.write(
      `${JSON.stringify({ code: "ERROR", message: error instanceof Error ? error.message : String(error) })}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${JSON.stringify({ url: server.url, port: server.port, tokenFile: server.tokenFile })}\n`,
  );
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let interrupts = 0;
  await new Promise<void>((done) => {
    const stop = (): void => {
      // A second signal while active runs wind down exits at once, like `baked workflow`.
      if (++interrupts > 1) process.exit(130);
      done();
    };
    for (const signal of signals) process.on(signal, stop);
  });
  await server.stop();
  return 0;
}
