/**
 * Windows OS sandbox backend ("restricted-token"): BAKED starts a small launcher (the BAKED
 * binary with `__sandbox-exec`, or this module's launcher script when running from source) that
 * runs the command with a restricted, low-integrity copy of the user's token inside a job object.
 *
 * Writes: a low-integrity process cannot write objects labeled medium, which is the implicit label
 * of every file, so it writes only where the launcher sets a low label first (the writable roots,
 * the package caches and a private temp directory). `.git/hooks`, `.git/config` and `.baked` inside
 * them get an explicit medium label back. Credential stores get a medium label with no-read-up, so
 * the command cannot read them while the user's own processes still can. Labels persist on disk;
 * the launcher checks them first and only changes what is missing.
 *
 * The job object kills every process of the command when the launcher exits or is stopped, and
 * blocks the clipboard, desktop switching and system settings. The network is not isolated.
 * The pure parts (spec encoding, command lines, environment block) are tested on any platform.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledBinary } from "./index.js";

/** The hidden subcommand of the BAKED binary that runs the launcher. */
export const SANDBOX_EXEC_COMMAND = "__sandbox-exec";
/** Exit status of the launcher when it cannot start the command (as `env` uses). */
export const LAUNCHER_FAILURE = 125;
/** The note recorded with a launch whose request denied the network. */
export const WINDOWS_NETWORK_GAP = "the Windows backend does not isolate the network";

/** What the launcher runs and how it labels the file system first. */
export interface WindowsSandboxSpec {
  executable: string;
  args: string[];
  /** The args are a ready command line (`bunShellArgs`), joined without quoting. */
  verbatim: boolean;
  cwd: string;
  writable: string[];
  caches: string[];
  protectDirs: string[];
  protectFiles: string[];
  hiddenDirs: string[];
  hiddenFiles: string[];
}

export function encodeSpec(spec: WindowsSandboxSpec): string {
  return Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
}

export function decodeSpec(text: string): WindowsSandboxSpec {
  const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as WindowsSandboxSpec;
  if (typeof value?.executable !== "string" || !Array.isArray(value.args))
    throw new Error("Malformed sandbox launch");
  return value;
}

/**
 * The program and leading arguments that start the launcher: the compiled binary takes the hidden
 * subcommand; from source, Bun runs the launcher script next to this module.
 */
export function windowsLauncher(): string[] {
  if (isCompiledBinary()) return [process.execPath, SANDBOX_EXEC_COMMAND];
  const script = fileURLToPath(new URL("./windows-sandbox-launcher.ts", import.meta.url));
  if (existsSync(script)) return [process.execPath, script];
  // A bundle run by Bun (`bun dist/index.js`) has no sibling script, but its entry handles the subcommand.
  return [process.execPath, process.argv[1] ?? "", SANDBOX_EXEC_COMMAND];
}

/** One argument quoted the way the MSVC runtime and libuv expect. */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') out += `${"\\".repeat(slashes * 2 + 1)}"`;
    else out += `${"\\".repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** The command line CreateProcess receives, matching what Bun's spawn would build. */
export function windowsCommandLine(executable: string, args: string[], verbatim: boolean): string {
  const rest = verbatim ? args : args.map(quoteWindowsArg);
  return [quoteWindowsArg(executable), ...rest].join(" ");
}

/** A batch script resolved on PATH runs through cmd.exe, as Bun's spawn cannot start it either. */
export function batchCommandLine(comspec: string, script: string, args: string[]): string {
  const line = [script, ...args].map(quoteWindowsArg).join(" ");
  return `${quoteWindowsArg(comspec)} /d /s /c "${line}"`;
}

/** A Unicode environment block: `NAME=value\0` sorted by name without case, then `\0`. */
export function environmentBlock(env: Record<string, string | undefined>): Buffer {
  const entries = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "")
    .sort(([a], [b]) =>
      a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0,
    );
  const text = `${entries.map(([name, value]) => `${name}=${value}\0`).join("")}\0`;
  return Buffer.from(text, "utf16le");
}

/** The private temp directory of sandboxed commands; it carries the low label. */
export function sandboxTempDir(): string {
  return join(tmpdir(), "baked-sandbox-low");
}

// ── Native part: runs only in the launcher on Windows ──────────────────────

type Pointer = import("bun:ffi").Pointer;
type Label = "low" | "protect" | "hidden";

const LABEL_SECURITY_INFORMATION = 0x10;
const PROTECTED_SACL_SECURITY_INFORMATION = 0x40000000;
const SE_FILE_OBJECT = 1;
const SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11;
const INHERITED_ACE = 0x10;
const NO_WRITE_UP = 0x1;
const NO_READ_UP = 0x2;
const LOW_RID = 0x1000;
const MEDIUM_RID = 0x2000;

const SDDL: Record<Label, { dir: string; file: string }> = {
  low: { dir: "S:(ML;OICI;NW;;;LW)", file: "S:(ML;;NW;;;LW)" },
  protect: { dir: "S:(ML;OICI;NW;;;ME)", file: "S:(ML;;NW;;;ME)" },
  hidden: { dir: "S:(ML;OICI;NWNR;;;ME)", file: "S:(ML;;NWNR;;;ME)" },
};

const wide = (text: string): Buffer => Buffer.from(`${text}\0`, "utf16le");

/**
 * Handles, SIDs, ACLs and security descriptors travel as u64 (bigint): the pseudo handle of the
 * current process is -1, which a JavaScript number pointer cannot carry. Buffers go as `ptr`.
 */
function loadWin32() {
  const ffi = require("bun:ffi") as typeof import("bun:ffi");
  const { dlopen, FFIType: T } = ffi;
  const advapi32 = dlopen("advapi32.dll", {
    GetNamedSecurityInfoW: {
      args: [T.ptr, T.u32, T.u32, T.ptr, T.ptr, T.ptr, T.ptr, T.ptr],
      returns: T.u32,
    },
    SetNamedSecurityInfoW: {
      args: [T.ptr, T.u32, T.u32, T.ptr, T.ptr, T.ptr, T.u64],
      returns: T.u32,
    },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: [T.ptr, T.u32, T.ptr, T.ptr],
      returns: T.i32,
    },
    GetSecurityDescriptorSacl: { args: [T.u64, T.ptr, T.ptr, T.ptr], returns: T.i32 },
    ConvertStringSidToSidW: { args: [T.ptr, T.ptr], returns: T.i32 },
    GetLengthSid: { args: [T.u64], returns: T.u32 },
    OpenProcessToken: { args: [T.u64, T.u32, T.ptr], returns: T.i32 },
    CreateRestrictedToken: {
      args: [T.u64, T.u32, T.u32, T.ptr, T.u32, T.ptr, T.u32, T.ptr, T.ptr],
      returns: T.i32,
    },
    SetTokenInformation: { args: [T.u64, T.u32, T.ptr, T.u32], returns: T.i32 },
    CreateProcessAsUserW: {
      args: [T.u64, T.ptr, T.ptr, T.ptr, T.ptr, T.i32, T.u32, T.ptr, T.ptr, T.ptr, T.ptr],
      returns: T.i32,
    },
  });
  const kernel32 = dlopen("kernel32.dll", {
    GetLastError: { args: [], returns: T.u32 },
    LocalFree: { args: [T.u64], returns: T.u64 },
    CloseHandle: { args: [T.u64], returns: T.i32 },
    CreateJobObjectW: { args: [T.ptr, T.ptr], returns: T.u64 },
    SetInformationJobObject: { args: [T.u64, T.u32, T.ptr, T.u32], returns: T.i32 },
    AssignProcessToJobObject: { args: [T.u64, T.u64], returns: T.i32 },
    GetStdHandle: { args: [T.u32], returns: T.u64 },
    SetHandleInformation: { args: [T.u64, T.u32, T.u32], returns: T.i32 },
    ResumeThread: { args: [T.u64], returns: T.u32 },
    TerminateProcess: { args: [T.u64, T.u32], returns: T.i32 },
    WaitForSingleObject: { args: [T.u64, T.u32], returns: T.u32 },
    GetExitCodeProcess: { args: [T.u64, T.ptr], returns: T.i32 },
  });
  return { ffi, a: advapi32.symbols, k: kernel32.symbols };
}

type Win32 = ReturnType<typeof loadWin32>;

/** GetCurrentProcess(): the pseudo handle (HANDLE)-1. */
const CURRENT_PROCESS = 0xffffffffffffffffn;

const handleAt = (buffer: Buffer, offset = 0): bigint => buffer.readBigUInt64LE(offset);
/** A native address as bun:ffi's `read` takes it; user-mode addresses fit a double. */
const addressOf = (value: bigint): Pointer => Number(value) as Pointer;

function fail(win: Win32, what: string, code?: number): never {
  throw new Error(`${what} failed (Windows error ${code ?? win.k.GetLastError()})`);
}

/** The first mandatory label of a path, or null when it has none (implicitly medium). */
function readLabel(
  win: Win32,
  path: string,
): { rid: number; mask: number; inherited: boolean } | null {
  const sacl = Buffer.alloc(8);
  const sd = Buffer.alloc(8);
  const status = win.a.GetNamedSecurityInfoW(
    wide(path),
    SE_FILE_OBJECT,
    LABEL_SECURITY_INFORMATION,
    null,
    null,
    null,
    sacl,
    sd,
  );
  if (status !== 0) fail(win, `Reading the integrity label of ${path}`, status);
  try {
    const aclHandle = handleAt(sacl);
    if (!aclHandle) return null;
    const acl = addressOf(aclHandle);
    const { read } = win.ffi;
    const count = read.u16(acl, 4);
    let offset = 8;
    for (let i = 0; i < count; i++) {
      const type = read.u8(acl, offset);
      const flags = read.u8(acl, offset + 1);
      const size = read.u16(acl, offset + 2);
      if (type === SYSTEM_MANDATORY_LABEL_ACE_TYPE) {
        const subAuthorities = read.u8(acl, offset + 9);
        // SID: revision, sub-authority count, 6-byte authority, then the RID.
        const rid = subAuthorities > 0 ? read.u32(acl, offset + 16) : MEDIUM_RID;
        return {
          rid,
          mask: read.u32(acl, offset + 4),
          inherited: (flags & INHERITED_ACE) !== 0,
        };
      }
      offset += size;
    }
    return null;
  } finally {
    const descriptor = handleAt(sd);
    if (descriptor) win.k.LocalFree(descriptor);
  }
}

function hasLabel(win: Win32, path: string, label: Label): boolean {
  const current = readLabel(win, path);
  if (label === "low") return current !== null && current.rid <= LOW_RID;
  if (!current || current.inherited || current.rid < MEDIUM_RID) return false;
  return label === "protect"
    ? (current.mask & NO_WRITE_UP) !== 0
    : (current.mask & NO_READ_UP) !== 0 && (current.mask & NO_WRITE_UP) !== 0;
}

/**
 * Sets the label when the path lacks it. Setting a label with inheritance on a directory makes
 * Windows propagate it to everything below, so the first launch in a large tree takes longer.
 */
function ensureLabel(win: Win32, path: string, label: Label): void {
  if (hasLabel(win, path, label)) return;
  const directory = statSync(path).isDirectory();
  const sd = Buffer.alloc(8);
  const sddl = directory ? SDDL[label].dir : SDDL[label].file;
  if (!win.a.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), 1, sd, null))
    fail(win, "Building an integrity label");
  const descriptor = handleAt(sd);
  try {
    const present = Buffer.alloc(4);
    const acl = Buffer.alloc(8);
    const defaulted = Buffer.alloc(4);
    if (!win.a.GetSecurityDescriptorSacl(descriptor, present, acl, defaulted))
      fail(win, "Reading an integrity label");
    // Protected: an inherited low label from a writable parent must not apply next to this one.
    const flags =
      LABEL_SECURITY_INFORMATION | (label === "low" ? 0 : PROTECTED_SACL_SECURITY_INFORMATION);
    const status = win.a.SetNamedSecurityInfoW(
      wide(path),
      SE_FILE_OBJECT,
      flags,
      null,
      null,
      null,
      handleAt(acl),
    );
    if (status !== 0) fail(win, `Setting the ${label} integrity label on ${path}`, status);
  } finally {
    win.k.LocalFree(descriptor);
  }
}

function sidFrom(win: Win32, text: string): bigint {
  const out = Buffer.alloc(8);
  if (!win.a.ConvertStringSidToSidW(wide(text), out)) fail(win, `Reading SID ${text}`);
  return handleAt(out);
}

/** A primary token without privileges or administrator rights, at low integrity. */
function restrictedToken(win: Win32): bigint {
  const own = Buffer.alloc(8);
  // TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT
  if (!win.a.OpenProcessToken(CURRENT_PROCESS, 0x8b, own)) fail(win, "OpenProcessToken");
  const token = handleAt(own);
  const administrators = sidFrom(win, "S-1-5-32-544");
  const disable = Buffer.alloc(16);
  disable.writeBigUInt64LE(administrators, 0);
  const restricted = Buffer.alloc(8);
  // DISABLE_MAX_PRIVILEGE; the administrators group becomes deny-only when the token has it.
  if (!win.a.CreateRestrictedToken(token, 0x1, 1, disable, 0, null, 0, null, restricted))
    fail(win, "CreateRestrictedToken");
  win.k.CloseHandle(token);
  win.k.LocalFree(administrators);
  const handle = handleAt(restricted);
  const low = sidFrom(win, "S-1-16-4096");
  const label = Buffer.alloc(16);
  label.writeBigUInt64LE(low, 0);
  label.writeUInt32LE(0x20, 8); // SE_GROUP_INTEGRITY
  // TokenIntegrityLevel
  if (!win.a.SetTokenInformation(handle, 25, label, 16 + win.a.GetLengthSid(low)))
    fail(win, "Lowering the token's integrity level");
  win.k.LocalFree(low);
  return handle;
}

/** A job that kills its processes when the launcher's handle closes, without clipboard or desktop access. */
function killOnCloseJob(win: Win32): bigint {
  const job = win.k.CreateJobObjectW(null, null);
  if (!job) fail(win, "CreateJobObject");
  const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!win.k.SetInformationJobObject(job, 9, limits, limits.length)) fail(win, "Limiting the job");
  // Clipboard read and write, system parameters, display settings, desktops, ExitWindows.
  const ui = Buffer.alloc(4);
  ui.writeUInt32LE(0x02 | 0x04 | 0x08 | 0x10 | 0x40 | 0x80, 0);
  win.k.SetInformationJobObject(job, 4, ui, ui.length);
  return job;
}

function resolveExecutable(
  executable: string,
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  if (isAbsolute(executable)) return executable;
  const found = Bun.which(executable, { PATH: env.PATH ?? env.Path ?? "", cwd });
  if (!found) throw new Error(`${executable}: command not found`);
  return found;
}

/** Labels the file system for the spec, then runs the command and returns its exit status. */
export function runWindowsSandbox(spec: WindowsSandboxSpec): number {
  const win = loadWin32();
  const temp = sandboxTempDir();
  mkdirSync(temp, { recursive: true });
  ensureLabel(win, temp, "low");
  for (const path of spec.writable) ensureLabel(win, path, "low");
  for (const path of spec.caches)
    try {
      ensureLabel(win, path, "low");
    } catch {
      // A cache the user cannot relabel stays read-only; tools fall back to fetching.
    }
  for (const path of [...spec.hiddenDirs, ...spec.hiddenFiles]) ensureLabel(win, path, "hidden");
  for (const path of [...spec.protectDirs, ...spec.protectFiles]) ensureLabel(win, path, "protect");

  const env: Record<string, string | undefined> = { ...process.env, TEMP: temp, TMP: temp };
  const resolved = resolveExecutable(spec.executable, env, spec.cwd);
  const comspec = env.ComSpec || env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
  const batch = /\.(cmd|bat)$/i.test(resolved);
  const application = batch ? comspec : resolved;
  const commandLine = batch
    ? batchCommandLine(comspec, resolved, spec.args)
    : windowsCommandLine(spec.executable, spec.args, spec.verbatim);

  const token = restrictedToken(win);
  const job = killOnCloseJob(win);
  const startup = Buffer.alloc(104); // STARTUPINFOW
  startup.writeUInt32LE(startup.length, 0);
  startup.writeUInt32LE(0x100, 60); // STARTF_USESTDHANDLES
  // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE as DWORDs.
  [0xfffffff6, 0xfffffff5, 0xfffffff4].forEach((id, index) => {
    const handle = win.k.GetStdHandle(id);
    if (handle) win.k.SetHandleInformation(handle, 1, 1); // HANDLE_FLAG_INHERIT
    startup.writeBigUInt64LE(handle, 80 + index * 8);
  });
  const info = Buffer.alloc(24); // PROCESS_INFORMATION
  // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW
  const flags = 0x4 | 0x400 | 0x08000000;
  const started = win.a.CreateProcessAsUserW(
    token,
    wide(application),
    wide(commandLine),
    null,
    null,
    1,
    flags,
    environmentBlock(env),
    wide(spec.cwd),
    startup,
    info,
  );
  if (!started) fail(win, `Starting ${spec.executable}`);
  const processHandle = handleAt(info, 0);
  const thread = handleAt(info, 8);
  if (!win.k.AssignProcessToJobObject(job, processHandle)) {
    const code = win.k.GetLastError();
    win.k.TerminateProcess(processHandle, LAUNCHER_FAILURE);
    fail(win, "Adding the command to its job", code);
  }
  win.k.ResumeThread(thread);
  win.k.CloseHandle(thread);
  win.k.WaitForSingleObject(processHandle, 0xffffffff);
  const exit = Buffer.alloc(4);
  win.k.GetExitCodeProcess(processHandle, exit);
  win.k.CloseHandle(processHandle);
  // Closing the job ends whatever the command left running, as bwrap's PID namespace does.
  win.k.CloseHandle(job);
  win.k.CloseHandle(token);
  const status = exit.readUInt32LE(0);
  // An NTSTATUS exit (0xC0000142: a DLL failed to initialize) means Windows refused to run the
  // command under the restricted token; say so, as the status alone does not fit an exit code.
  if (status >= 0xc0000000) {
    process.stderr.write(
      `baked sandbox: ${spec.executable} ended with status 0x${status.toString(16)}\n`,
    );
    return LAUNCHER_FAILURE;
  }
  return status;
}

/** `__sandbox-exec <spec>`: the launcher's entry point; returns the process exit status. */
export function runSandboxExecCli(args: string[]): number {
  try {
    if (process.platform !== "win32") throw new Error("The Windows sandbox runs only on Windows");
    const encoded = args[0];
    if (!encoded) throw new Error("Missing sandbox launch");
    return runWindowsSandbox(decodeSpec(encoded));
  } catch (error) {
    process.stderr.write(
      `baked sandbox: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return LAUNCHER_FAILURE;
  }
}
