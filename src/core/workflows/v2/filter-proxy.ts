/**
 * The local filtering proxy of the AI acceptance gate (workflow v2 design, section 9.2): an
 * HTTP forward proxy on loopback that serves plain HTTP requests and CONNECT tunnels only for the
 * exact hosts in `outboundHosts` and for loopback on the granted ports. Everything else gets 403
 * and is recorded as a refusal.
 */
import { connect, createServer, type Server, type Socket } from "node:net";

/** Request heads larger than this are refused; browsers send a few kilobytes. */
const MAX_HEAD = 64 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export interface ProxyDecision {
  at: string;
  method: string;
  host: string;
  port: number;
  allowed: boolean;
  /** Why the request was refused; null when it was allowed. */
  reason: string | null;
}

/** Maps a requested host to the address actually connected; tests map fake names to fixtures. */
export type ProxyResolver = (host: string, port: number) => { host: string; port: number };

export interface FilterProxyOptions {
  outboundHosts: readonly string[];
  /** Loopback ports the driver may reach: the application's granted `listenPorts`. */
  loopbackPorts: readonly number[];
  resolve?: ProxyResolver;
  onDecision?: (decision: ProxyDecision) => void;
}

export const normalizeHost = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");

/** Why a host and port are refused under the grant, or null when they are allowed. */
export function refusalReason(
  host: string,
  port: number,
  grant: Pick<FilterProxyOptions, "outboundHosts" | "loopbackPorts">,
): string | null {
  const name = normalizeHost(host);
  if (LOOPBACK.has(name) || /^127\.\d+\.\d+\.\d+$/.test(name))
    return grant.loopbackPorts.includes(port)
      ? null
      : `loopback port ${port} is not a granted listen port`;
  return grant.outboundHosts.some((h) => normalizeHost(h) === name)
    ? null
    : `${name} is not in outboundHosts`;
}

/** Splits `host:port`, including a bracketed IPv6 host. */
function authority(text: string, fallbackPort: number): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(text.trim());
  if (!match?.[1]) return null;
  const port = match[2] ? Number(match[2]) : fallbackPort;
  return port > 0 && port < 65536 ? { host: normalizeHost(match[1]), port } : null;
}

const HOP_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "upgrade",
]);

export class FilterProxy {
  readonly decisions: ProxyDecision[] = [];
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private boundPort = 0;
  constructor(private options: FilterProxyOptions) {}
  get port(): number {
    return this.boundPort;
  }
  /** The proxy URL a browser or a test is configured with. */
  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }
  get refusals(): ProxyDecision[] {
    return this.decisions.filter((d) => !d.allowed);
  }
  /** Listens on 127.0.0.1 on an ephemeral port and returns the port. */
  start(): Promise<number> {
    if (this.server) return Promise.resolve(this.boundPort);
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        this.boundPort = typeof address === "object" && address ? address.port : 0;
        resolve(this.boundPort);
      });
    });
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }
  private decide(method: string, host: string, port: number): ProxyDecision {
    const reason = refusalReason(host, port, this.options);
    const decision: ProxyDecision = {
      at: new Date().toISOString(),
      method,
      host,
      port,
      allowed: reason === null,
      reason,
    };
    this.decisions.push(decision);
    this.options.onDecision?.(decision);
    return decision;
  }
  private accept(client: Socket): void {
    this.track(client);
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffer.length > MAX_HEAD) reply(client, 431, "Request header too large");
        return;
      }
      client.off("data", onData);
      client.pause();
      this.handle(client, buffer.subarray(0, end).toString("latin1"), buffer.subarray(end + 4));
    };
    client.on("data", onData);
  }
  private handle(client: Socket, head: string, rest: Buffer): boolean {
    const [requestLine = "", ...headerLines] = head.split("\r\n");
    const [method = "", target = "", version = ""] = requestLine.split(" ");
    if (!method || !target || !version.startsWith("HTTP/"))
      return reply(client, 400, "Malformed request");
    if (method.toUpperCase() === "CONNECT") {
      const where = authority(target, 443);
      if (!where) return reply(client, 400, "Malformed CONNECT target");
      const decision = this.decide("CONNECT", where.host, where.port);
      if (!decision.allowed) return reply(client, 403, `Refused by BAKED: ${decision.reason}`);
      const to = this.options.resolve?.(where.host, where.port) ?? where;
      const upstream = connect(to.port, to.host);
      this.track(upstream);
      let open = false;
      upstream.once("error", () =>
        open ? client.destroy() : reply(client, 502, "Upstream connection failed"),
      );
      upstream.once("connect", () => {
        open = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      return true;
    }
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return reply(client, 400, "A proxy request needs an absolute http:// URL");
    }
    if (url.protocol !== "http:") return reply(client, 400, `Unsupported scheme ${url.protocol}`);
    const host = normalizeHost(url.hostname);
    const port = url.port ? Number(url.port) : 80;
    const decision = this.decide(method.toUpperCase(), host, port);
    if (!decision.allowed) return reply(client, 403, `Refused by BAKED: ${decision.reason}`);
    const headers: string[] = [];
    let length = 0;
    for (const line of headerLines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      if (name === "transfer-encoding")
        return reply(client, 411, "Chunked request bodies are not supported");
      if (name === "content-length") length = Number(line.slice(colon + 1).trim()) || 0;
      if (!HOP_HEADERS.has(name)) headers.push(line);
    }
    // One request per connection: whatever the client sends after the body is not forwarded,
    // so a reused connection cannot reach another host past the filter.
    const out = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join("\r\n")}\r\nConnection: close\r\n\r\n`;
    const to = this.options.resolve?.(host, port) ?? { host, port };
    const upstream = connect(to.port, to.host);
    this.track(upstream);
    upstream.once("error", () => reply(client, 502, "Upstream connection failed"));
    upstream.once("connect", () => {
      upstream.write(out);
      let remaining = length;
      const forward = (chunk: Buffer): void => {
        if (remaining <= 0) return;
        const part = chunk.subarray(0, remaining);
        remaining -= part.length;
        upstream.write(part);
      };
      forward(rest);
      client.on("data", forward);
      upstream.pipe(client);
      client.resume();
    });
    return true;
  }
}

function reply(socket: Socket, status: number, text: string): false {
  if (socket.destroyed) return false;
  const reasons: Record<number, string> = {
    400: "Bad Request",
    403: "Forbidden",
    411: "Length Required",
    431: "Request Header Fields Too Large",
    502: "Bad Gateway",
  };
  const body = `${text}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reasons[status] ?? "Error"}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  return false;
}
