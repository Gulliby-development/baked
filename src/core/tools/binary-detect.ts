import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { isBinaryFileSync } from "isbinaryfile";

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".tiff",
  ".avif",
  ".heic",
]);
const DOC_EXTS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".ogg", ".aac", ".m4a", ".wma"]);
const VIDEO_EXTS = new Set([".mp4", ".avi", ".mov", ".mkv", ".webm", ".wmv", ".flv"]);
const ARCHIVE_EXTS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".zst",
  ".tar.gz",
]);
const DB_EXTS = new Set([".db", ".sqlite", ".sqlite3"]);

export function binaryHint(ext: string): string {
  if (IMAGE_EXTS.has(ext))
    return " This is an image file. Describe what you need from it or ask the user to describe its contents.";
  if (DOC_EXTS.has(ext))
    return " This is a document. Use shell to extract text: `pdftotext file.pdf -` for PDFs, or ask the user to paste the relevant content.";
  if (AUDIO_EXTS.has(ext)) return " This is an audio file. It cannot be processed as text.";
  if (VIDEO_EXTS.has(ext)) return " This is a video file. It cannot be processed as text.";
  if (ARCHIVE_EXTS.has(ext))
    return " This is an archive. Use shell to list contents: `tar tf` / `unzip -l` / `7z l`.";
  if (DB_EXTS.has(ext)) return " This is a database. Use shell with `sqlite3` to query it.";
  if (ext === ".wasm")
    return " This is a WebAssembly binary. Use `wasm-objdump` or `wasm2wat` to inspect.";
  return " Binary files cannot be read as text. Use shell commands if you need to inspect this file.";
}

/**
 * Format a binary file error with size and helpful hints.
 * Returns null if the file is not binary or doesn't exist.
 */
function checkBinaryFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    if (!isBinaryFileSync(filePath)) return null;
    const ext = extname(filePath).toLowerCase();
    const sizeStr =
      stat.size > 1024 * 1024
        ? `${(stat.size / (1024 * 1024)).toFixed(1)}MB`
        : `${(stat.size / 1024).toFixed(0)}KB`;
    return `Cannot read binary file: "${filePath}" (${ext || "no extension"}, ${sizeStr}).${binaryHint(ext)}`;
  } catch {
    return null;
  }
}

/** Commands that directly read file contents */
const CAT_CMDS = new Set(["cat", "head", "tail", "less", "more", "bat", "tac", "nl"]);

/**
 * Check if a shell command would cat/head/tail a binary file.
 * Returns error message or null.
 */
export function checkShellBinaryRead(command: string, cwd: string): string | null {
  const parts = command.split(/[|;&]/);
  const first = (parts[0] ?? "").trim();
  const tokens = first.split(/\s+/);
  const cmd = tokens[0];
  if (!cmd || !CAT_CMDS.has(cmd)) return null;
  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i];
    if (!arg || arg.startsWith("-")) continue;
    const abs = resolve(cwd, arg);
    const err = checkBinaryFile(abs);
    if (err) return err;
  }
  return null;
}
