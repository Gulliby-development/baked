/**
 * Keeps Windows from handing `pid` to a new process until the returned function runs (#2900).
 * Windows reuses a PID as soon as no handle to the old process is open, and a busy runner starts
 * processes all the time, so a test that asks whether a stopped process (or its tree) is still
 * alive can read a stranger's live process under the old PID. Call it while the process still
 * runs; a process that already exited may have lost its PID. Elsewhere it does nothing: POSIX
 * reuses PIDs only after the whole range has cycled.
 */
export function pinPid(pid: number): () => void {
  if (process.platform !== "win32") return () => {};
  const { dlopen, FFIType: T } = require("bun:ffi") as typeof import("bun:ffi");
  const kernel32 = dlopen("kernel32.dll", {
    OpenProcess: { args: [T.u32, T.i32, T.u32], returns: T.u64 },
    CloseHandle: { args: [T.u64], returns: T.i32 },
  });
  const SYNCHRONIZE = 0x00100000;
  const handle = kernel32.symbols.OpenProcess(SYNCHRONIZE, 0, pid);
  if (BigInt(handle) === 0n) {
    kernel32.close();
    throw new Error(`pinPid: could not open process ${pid}; pin it before it exits`);
  }
  return () => {
    kernel32.symbols.CloseHandle(handle);
    kernel32.close();
  };
}

/**
 * A `bun -e` body that prints `printed`, then waits for a line on standard input before it exits,
 * so the test can `pinPid` the process while it still runs. End the wait with `release(child)`.
 */
export const exitOnInput = (body: string): string => `${body} process.stdin.once("data", () => process.exit(0));`;

/** Lets a process started with `exitOnInput` exit. */
export function release(child: { stdin: { write(data: string): unknown; end(): unknown } }): void {
  child.stdin.write("exit\n");
  child.stdin.end();
}

/** Reads the first line a child prints, without waiting for it to close its output. */
export async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0]?.trim() ?? "";
}
