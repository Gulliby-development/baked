import { describe, expect, test } from "bun:test";
import { baseVersion, bumpVersion, latestTag, planRelease, stampVersion } from "../scripts/scheduled-release";

const HOUR = 3600;
const NOW = 1_800_000_000;

const base = {
  tag: "v0.5.0",
  tagCreatedAt: NOW - 48 * HOUR,
  newCommits: 12,
  packageVersion: "0.5.0",
  bump: "minor" as const,
  force: false,
  now: NOW,
};

describe("scheduled release", () => {
  test("picks the highest semver tag, not the newest string", () => {
    expect(latestTag(["v0.9.0", "v0.10.0", "v0.2.1", "nightly", "v1.0.0-rc.1", ""])).toBe("v0.10.0");
    expect(latestTag([])).toBeNull();
  });

  test("bumps from the higher of the tag and package.json", () => {
    expect(baseVersion("v0.6.0", "0.5.0")).toBe("0.6.0");
    expect(baseVersion("v0.5.0", "0.7.0")).toBe("0.7.0");
    expect(baseVersion(null, "0.5.0")).toBe("0.5.0");
    expect(bumpVersion("0.5.3", "minor")).toBe("0.6.0");
    expect(bumpVersion("0.5.3", "patch")).toBe("0.5.4");
    expect(bumpVersion("0.5.3", "major")).toBe("1.0.0");
  });

  test("releases the next minor once the last tag is two days old", () => {
    expect(planRelease(base)).toMatchObject({ release: true, version: "0.6.0", tag: "v0.6.0" });
    // main still says 0.5.0 after a scheduled 0.6.0, so the following one is 0.7.0.
    expect(planRelease({ ...base, tag: "v0.6.0" })).toMatchObject({ release: true, tag: "v0.7.0" });
  });

  test("tolerates a cron run that starts a little early", () => {
    expect(planRelease({ ...base, tagCreatedAt: NOW - 45 * HOUR }).release).toBe(true);
  });

  test("skips when the last release is under the interval, unless forced", () => {
    const recent = { ...base, tagCreatedAt: NOW - 24 * HOUR };
    expect(planRelease(recent)).toMatchObject({ release: false });
    expect(planRelease({ ...recent, force: true })).toMatchObject({ release: true, tag: "v0.6.0" });
  });

  test("skips when main has no new commits, even when forced", () => {
    expect(planRelease({ ...base, newCommits: 0, force: true })).toMatchObject({ release: false });
  });

  test("stamps only the version field", () => {
    const text = '{\n  "name": "baked",\n  "version": "0.5.0",\n  "private": true\n}\n';
    expect(stampVersion(text, "0.6.0")).toBe('{\n  "name": "baked",\n  "version": "0.6.0",\n  "private": true\n}\n');
    expect(() => stampVersion("{}", "0.6.0")).toThrow();
  });
});
