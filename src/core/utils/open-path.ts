/**
 * Cross-platform "open this path/url with the OS default handler".
 *
 *   macOS:   `open <path>`
 *   Linux:   `xdg-open <path>`
 *   Windows: a web URL through `rundll32 url.dll,FileProtocolHandler <url>`, anything else
 *            through `cmd.exe /c start "" <path>` (empty title arg required when the path
 *            contains spaces or special chars — otherwise `start` treats the first quoted
 *            arg as a window title and silently does nothing).
 *
 * Returns true on spawn success, false on any failure. Never throws.
 * Fire-and-forget: stdio is ignored, errors are swallowed.
 */
import { IS_DARWIN, IS_WIN } from "../platform/index.js";

/** An http(s) URL that is one argument: no whitespace, quotes or angle brackets. */
const WEB_URL = /^https?:\/\/[^\s"'`<>]+$/i;

/** The command that opens `pathOrUrl` on `platform`, or null when it cannot be opened safely. */
export function openCommand(
  pathOrUrl: string,
  platform: "win32" | "darwin" | "linux",
): string[] | null {
  if (platform === "win32") {
    // OAuth and other web URLs carry `&` and `%` in their query, which `cmd /c start` would read
    // as shell syntax; url.dll takes the URL as one argument without a shell (#1180).
    if (WEB_URL.test(pathOrUrl)) return ["rundll32.exe", "url.dll,FileProtocolHandler", pathOrUrl];
    // `cmd /c start` interprets `&`, `^`, `%`, `|`, `\"` as shell metacharacters, opening the
    // user up to argument injection if pathOrUrl came from untrusted input (LLM-generated link,
    // pasted text). Reject a path containing those before invoking cmd.exe.
    if (/[&^%|"`<>]/.test(pathOrUrl)) return null;
    return ["cmd.exe", "/c", "start", "", pathOrUrl];
  }
  return [platform === "darwin" ? "open" : "xdg-open", pathOrUrl];
}

export function openPath(pathOrUrl: string): boolean {
  try {
    const command = openCommand(pathOrUrl, IS_WIN ? "win32" : IS_DARWIN ? "darwin" : "linux");
    if (!command) return false;
    Bun.spawn(command, {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: IS_WIN,
    });
    return true;
  } catch {
    return false;
  }
}
