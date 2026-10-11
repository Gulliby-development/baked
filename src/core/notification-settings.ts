/**
 * Edits of the global `notifications` config (system notifications and the run attention
 * webhook) shared by the `/notifications` command and any other front end. Pure: callers read the
 * current value and write the result with their config writer.
 */
import type { NotificationsConfig } from "../types/index.js";

export interface NotificationsChange {
  system?: boolean;
  /** A new webhook URL, or null to remove the webhook with its headers. */
  webhookUrl?: string | null;
  blockingOnly?: boolean;
}

export type NotificationsResult =
  | { ok: true; value: NotificationsConfig }
  | { ok: false; error: string };

/** The URL form the desktop app accepts too: http(s) with no spaces. */
export function isWebhookUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

/** Parses on/off words; null for anything else. */
export function parseOnOff(value: string | undefined): boolean | null {
  const v = value?.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "yes" || v === "1") return true;
  if (v === "off" || v === "false" || v === "no" || v === "0") return false;
  return null;
}

/** Applies one change; headers and other webhook fields are kept unless the webhook is removed. */
export function applyNotificationsChange(
  current: NotificationsConfig | undefined,
  change: NotificationsChange,
): NotificationsResult {
  const { webhook, ...rest } = current ?? {};
  const next: NotificationsConfig =
    change.webhookUrl === null || !webhook ? rest : { ...rest, webhook };
  if (change.system !== undefined) next.system = change.system;
  if (change.webhookUrl !== undefined && change.webhookUrl !== null) {
    const url = change.webhookUrl.trim();
    if (!isWebhookUrl(url))
      return { ok: false, error: "The webhook URL must start with http:// or https://" };
    next.webhook = { ...next.webhook, url };
  }
  if (change.blockingOnly !== undefined) {
    if (!next.webhook?.url) return { ok: false, error: "Set a webhook URL first" };
    next.webhook = { ...next.webhook, blockingOnly: change.blockingOnly };
  }
  return { ok: true, value: next };
}

export const NOTIFICATIONS_USAGE = [
  "/notifications                       show the settings and a menu",
  "/notifications system on|off         desktop notifications from the terminal app and the CLI",
  "/notifications webhook URL           post each waiting run to URL",
  "/notifications webhook off           remove the webhook",
  "/notifications blocking-only on|off  only requests the run waits for",
].join("\n");

/** Parses `/notifications` arguments; an empty list means show the settings. */
export function parseNotificationsArgs(
  args: string[],
): { change: NotificationsChange } | { error: string } | { show: true } {
  const [what, value, ...rest] = args;
  if (!what) return { show: true };
  if (rest.length > 0 || value === undefined) return { error: NOTIFICATIONS_USAGE };
  switch (what.toLowerCase()) {
    case "system": {
      const on = parseOnOff(value);
      return on === null ? { error: NOTIFICATIONS_USAGE } : { change: { system: on } };
    }
    case "webhook": {
      const off = ["off", "none", "remove"].includes(value.toLowerCase());
      return { change: { webhookUrl: off ? null : value } };
    }
    case "blocking-only": {
      const on = parseOnOff(value);
      return on === null ? { error: NOTIFICATIONS_USAGE } : { change: { blockingOnly: on } };
    }
    default:
      return { error: NOTIFICATIONS_USAGE };
  }
}

/** One line per setting, for a status message. */
export function describeNotifications(config: NotificationsConfig | undefined): string[] {
  const url = config?.webhook?.url;
  const headers = Object.keys(config?.webhook?.headers ?? {}).length;
  return [
    `System notifications: ${config?.system === false ? "off" : "on"}`,
    url
      ? `Webhook: ${url}${config?.webhook?.blockingOnly ? " (blocking requests only)" : ""}${
          headers ? `, ${String(headers)} header(s) from the config file` : ""
        }`
      : "Webhook: none (nothing is sent)",
  ];
}
