/**
 * Transcribes two seconds of silence with the staged speech engine (`bun run stage:voice`), so CI
 * proves the bundled model loads and runs. Recognition quality of real speech is checked by hand.
 *
 *   bun scripts/voice-check.ts [<voice-dir>]
 */
import { join } from "node:path";
import { VOICE_SAMPLE_RATE, VoiceEngine } from "../src/main/voice.ts";

const dir = Bun.argv[2] ?? join(import.meta.dir, "..", "dist", ".stage", "voice");
const voice = new VoiceEngine(dir);
const status = voice.status();
if (!status.available) {
  console.error(`voice-check: ${status.reason}`);
  process.exit(1);
}
const started = performance.now();
const result = await voice.transcribe(new Float32Array(VOICE_SAMPLE_RATE * 2), "en");
await voice.close();
console.log(
  `voice-check: ${JSON.stringify(result)} in ${Math.round(performance.now() - started)} ms`,
);
if (Math.abs(result.durationSeconds - 2) > 0.1) {
  console.error("voice-check: the engine reported the wrong duration");
  process.exit(1);
}
