/**
 * Native desktop notifications from a terminal process: `osascript` on macOS, `notify-send` on
 * Linux and a Windows PowerShell toast on Windows. Title and body never pass through a shell or a
 * script source: macOS reads them as `osascript` arguments, Windows from environment variables.
 * Delivery is best effort; a missing notifier or a desktop session without one is not an error.
 */
import { spawn } from "node:child_process";
import { findOnPath, IS_DARWIN, IS_WIN } from "./index.js";

const WINDOWS_TOAST = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$n = $t.GetElementsByTagName('text')",
  "$n.Item(0).AppendChild($t.CreateTextNode($env:BAKED_NOTIFY_TITLE)) > $null",
  "$n.Item(1).AppendChild($t.CreateTextNode($env:BAKED_NOTIFY_BODY)) > $null",
  // Windows shows toasts only for a registered app id; PowerShell's own is always registered.
  "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($t))",
].join("; ");

/** The command that shows a notification on this OS, or null when there is none. */
export function notificationCommand(
  title: string,
  body: string,
): { cmd: string; args: string[]; env?: Record<string, string> } | null {
  if (IS_WIN)
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_TOAST],
      env: { BAKED_NOTIFY_TITLE: title, BAKED_NOTIFY_BODY: body },
    };
  if (IS_DARWIN)
    return {
      cmd: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ],
    };
  const notifySend = findOnPath("notify-send");
  return notifySend ? { cmd: notifySend, args: ["--app-name=BAKED", title, body] } : null;
}

/** Shows a native notification; resolves whether a notifier ran and exited cleanly. Never rejects. */
export function showSystemNotification(title: string, body: string): Promise<boolean> {
  const command = notificationCommand(title, body);
  if (!command) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(command.cmd, command.args, {
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ...command.env },
      });
      const timer = setTimeout(() => child.kill(), 10_000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}
