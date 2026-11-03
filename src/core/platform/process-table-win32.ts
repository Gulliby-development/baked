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

function startedMs(k: NonNullable<typeof kernel32>, pid: number): number | null {
  const handle = handleOf(k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (handle === 0n) return null;
  try {
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

/** Whether `pid` is listed, and its listed children with their start times; null when unreadable. */
export function windowsProcessTree(pid: number): WindowsProcessTree | null {
  const k = load();
  if (!k) return null;
  const snapshot = handleOf(k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot === INVALID_HANDLE_VALUE || snapshot === 0n) return null;
  const childIds: number[] = [];
  let listed = false;
  let count = 0;
  try {
    const entry = Buffer.alloc(ENTRY_SIZE);
    entry.writeUInt32LE(ENTRY_SIZE, 0);
    const at = entry as unknown as Pointer;
    for (let ok = k.Process32FirstW(snapshot, at); ok; ok = k.Process32NextW(snapshot, at)) {
      count++;
      const id = entry.readUInt32LE(PROCESS_ID_OFFSET);
      if (id === pid) listed = true;
      else if (entry.readUInt32LE(PARENT_ID_OFFSET) === pid) childIds.push(id);
    }
  } finally {
    k.CloseHandle(snapshot);
  }
  // A snapshot always lists at least the System process and this one.
  if (count === 0) return null;
  return { listed, children: childIds.map((id) => ({ id, startedMs: startedMs(k, id) })) };
}
