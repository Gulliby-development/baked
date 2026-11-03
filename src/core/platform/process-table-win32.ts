/**
 * The Windows process table read in process (bun:ffi → kernel32.dll), for `processTreeAlive`.
 *
 * A Toolhelp snapshot lists every process with its parent PID in a few milliseconds; only the
 * children of the asked PID are then opened for their creation time. The PowerShell CIM query it
 * replaces took about a second and, on a loaded Windows runner, ran past its 15 s timeout, which
 * read as "may still run" and refused a recovery whose command had stopped (#2839).
 *
 * Returns null when bun:ffi or kernel32 is not available or the snapshot fails, so the caller
 * falls back to the PowerShell query. This file imports nothing from `./index.js`, which imports it.
 */

type Pointer = import("bun:ffi").Pointer;

/** A child of the asked process; `startedMs` is null when its creation time cannot be read. */
export type WindowsChild = { id: number; startedMs: number | null };
export type WindowsProcessTree = { listed: boolean; children: WindowsChild[] };

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
/** sizeof(PROCESSENTRY32W) on x64: 44 bytes of fields, WCHAR[260], padded to 8. */
const ENTRY_SIZE = 568;
const PROCESS_ID_OFFSET = 8;
const PARENT_ID_OFFSET = 32;
/** Windows FILETIME (100 ns since 1601) to Unix milliseconds. */
const FILETIME_UNIX_OFFSET_MS = 11644473600000;

function loadKernel32() {
  const { dlopen, FFIType: T } = require("bun:ffi") as typeof import("bun:ffi");
  return dlopen("kernel32.dll", {
    CreateToolhelp32Snapshot: { args: [T.u32, T.u32], returns: T.u64 },
    Process32FirstW: { args: [T.u64, T.ptr], returns: T.i32 },
    Process32NextW: { args: [T.u64, T.ptr], returns: T.i32 },
    OpenProcess: { args: [T.u32, T.i32, T.u32], returns: T.u64 },
    GetProcessTimes: { args: [T.u64, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
    GetExitCodeProcess: { args: [T.u64, T.ptr], returns: T.i32 },
    CloseHandle: { args: [T.u64], returns: T.i32 },
  }).symbols;
}

let kernel32: ReturnType<typeof loadKernel32> | null | undefined;

function load(): ReturnType<typeof loadKernel32> | null {
  if (kernel32 !== undefined) return kernel32;
  kernel32 = null;
  if (process.platform !== "win32" || typeof Bun === "undefined") return null;
  try {
    kernel32 = loadKernel32();
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

const handleOf = (value: number | bigint): bigint => BigInt.asUintN(64, BigInt(value));

const STILL_ACTIVE = 259;

/**
 * A listed process that has already exited, or its start time when it may still run (null when
 * unreadable). A snapshot still lists a process that is being torn down for a moment after it
 * exited, which read as a live descendant right after the test killed it.
 */
function inspect(k: NonNullable<typeof kernel32>, pid: number): "exited" | number | null {
  const handle = handleOf(k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (handle === 0n) return null;
  try {
    const code = Buffer.alloc(4);
    if (
      k.GetExitCodeProcess(handle, code as unknown as Pointer) &&
      code.readUInt32LE(0) !== STILL_ACTIVE
    )
      return "exited";
    const times = Buffer.alloc(32);
    const ok = k.GetProcessTimes(
      handle,
      times as unknown as Pointer,
      times.subarray(8) as unknown as Pointer,
      times.subarray(16) as unknown as Pointer,
      times.subarray(24) as unknown as Pointer,
    );
    if (!ok) return null;
    return Number(times.readBigUInt64LE(0)) / 10000 - FILETIME_UNIX_OFFSET_MS;
  } finally {
    k.CloseHandle(handle);
  }
}

/** Every listed process id with its parent id; null when the snapshot cannot be read. */
function snapshot(k: NonNullable<typeof kernel32>): Map<number, number> | null {
  const handle = handleOf(k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (handle === INVALID_HANDLE_VALUE || handle === 0n) return null;
  const parents = new Map<number, number>();
  try {
    const entry = Buffer.alloc(ENTRY_SIZE);
    entry.writeUInt32LE(ENTRY_SIZE, 0);
    const at = entry as unknown as Pointer;
    for (let ok = k.Process32FirstW(handle, at); ok; ok = k.Process32NextW(handle, at))
      parents.set(entry.readUInt32LE(PROCESS_ID_OFFSET), entry.readUInt32LE(PARENT_ID_OFFSET));
  } finally {
    k.CloseHandle(handle);
  }
  // A snapshot always lists at least the System process and this one.
  return parents.size === 0 ? null : parents;
}

/** Whether `pid` is listed, and its listed children with their start times; null when unreadable. */
export function windowsProcessTree(pid: number): WindowsProcessTree | null {
  const k = load();
  if (!k) return null;
  return readProcessTree(
    pid,
    () => snapshot(k),
    (id) => inspect(k, id),
  );
}

type ProcessState = "exited" | number | null;

/**
 * The tree of `pid` from a process snapshot (id → parent id) and a per-process inspection;
 * exported with injectable reads so the exit race is tested on every OS.
 */
export function readProcessTree(
  pid: number,
  readSnapshot: () => Map<number, number> | null,
  inspectProcess: (id: number) => ProcessState,
): WindowsProcessTree | null {
  const first = readSnapshot();
  if (!first) return null;
  const states = new Map<number, ProcessState>();
  for (const [id, parent] of first)
    if (id === pid || parent === pid) states.set(id, inspectProcess(id));
  // A process that exits between the snapshot and OpenProcess cannot be opened any more, which
  // reads the same as one this user may not open. A second snapshot tells them apart: the exited
  // one is no longer listed under the same parent, the protected one still is (#2840 flake).
  if ([...states.values()].includes(null)) {
    const second = readSnapshot();
    if (second)
      for (const [id, state] of states)
        if (state === null && second.get(id) !== first.get(id)) states.set(id, "exited");
  }
  const children: WindowsChild[] = [];
  for (const [id, state] of states)
    if (id !== pid && state !== "exited") children.push({ id, startedMs: state });
  return { listed: states.has(pid) && states.get(pid) !== "exited", children };
}
