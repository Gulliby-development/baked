import { hashJson } from "../specs/hash.js";
import type { RuntimeState } from "./types.js";

export function approvalDigest(state: RuntimeState): string {
  return hashJson({
    manifest: state.manifest,
    boundedCorrection: {
      rule: "bounded-correction",
      writes: state.graph?.tasks.flatMap((t) => t.writes) ?? [],
      profiles: state.graph?.tasks.map((t) => t.profileId) ?? [],
      checks: state.graph?.tasks.flatMap((t) => t.checkIds) ?? [],
    },
  });
}
