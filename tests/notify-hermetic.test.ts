import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { IS_DARWIN, IS_WIN } from "../src/core/platform/index.js";
import { showSystemNotification, systemNotificationsDisabled } from "../src/core/platform/notify.js";

const saved = { PATH: process.env.PATH, off: process.env.BAKED_NO_SYSTEM_NOTIFICATIONS };
const dirs: string[] = [];
afterEach(() => {
  process.env.PATH = saved.PATH;
  process.env.BAKED_NO_SYSTEM_NOTIFICATIONS = saved.off;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the test suite never reaches the native notifier", () => {
  // Set by tests/setup/isolate-home.ts, and inherited by the workflow workers tests start.
  expect(systemNotificationsDisabled()).toBe(true);
});

// A fake notify-send records whether it ran; Linux finds the notifier on PATH.
test.skipIf(IS_WIN || IS_DARWIN)("BAKED_NO_SYSTEM_NOTIFICATIONS stops the notifier from running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-notify-"));
  dirs.push(dir);
  const marker = join(dir, "ran");
  const notifier = join(dir, "notify-send");
  writeFileSync(notifier, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(notifier, 0o755);
  process.env.PATH = `${dir}${delimiter}${saved.PATH ?? ""}`;

  expect(await showSystemNotification("project: feature", "Waiting")).toBe(false);
  expect(existsSync(marker)).toBe(false);

  process.env.BAKED_NO_SYSTEM_NOTIFICATIONS = "0";
  expect(await showSystemNotification("project: feature", "Waiting")).toBe(true);
  expect(existsSync(marker)).toBe(true);
});
