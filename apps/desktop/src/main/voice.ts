import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  VOICE_LANGUAGES,
  type VoiceLanguage,
  type VoiceStatus,
  type VoiceTranscript,
} from "../shared/api.js";

/** The engine works on 16 kHz mono samples and takes at most 30 seconds per call. */
export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_MAX_SECONDS = 30;

/** Where the speech engine lives: `<dir>/cactus-needle` (the package) and `<dir>/whistle.cact`. */
export interface VoiceLocation {
  /** `BAKED_VOICE_DIR`, used by tests and to point a dev build at another copy. */
  override?: string;
  packaged: boolean;
  /** `process.resourcesPath` of the packaged app. */
  resourcesPath: string;
  /** `app.getAppPath()` when running from source, where `bun run stage:voice` stages it. */
  appPath: string;
}

export function resolveVoiceDir(location: VoiceLocation): string {
  if (location.override) return location.override;
  if (location.packaged) return join(location.resourcesPath, "voice");
  return join(location.appPath, "dist", ".stage", "voice");
}

interface WhistleResult {
  text: string;
  language: string;
  durationInSeconds: number;
}

interface Whistle {
  transcribe(audio: Float32Array, options?: { language?: string }): Promise<WhistleResult>;
  close(): Promise<void>;
}

interface NeedleModule {
  createWhistle(options: { modelPath: string }): Promise<Whistle>;
}

interface ModelManifest {
  speechModel?: { size?: number };
}

const MODEL_FILE = "whistle.cact";

/**
 * Local speech-to-text for the composer. The model runs in the package's own worker thread, so
 * inference never blocks the main process, and it never touches the network: the package and the
 * model are bundled with the app and verified when they are staged.
 */
export class VoiceEngine {
  private whistle: Promise<Whistle> | null = null;

  constructor(private readonly dir: string) {}

  private get packageDir(): string {
    return join(this.dir, "cactus-needle");
  }

  private get modelPath(): string {
    return join(this.dir, MODEL_FILE);
  }

  /** Whether transcription can run here, and why not; reads only file metadata. */
  status(): VoiceStatus {
    const entry = join(this.packageDir, "dist", "index.js");
    if (!existsSync(entry)) {
      return { available: false, reason: `The speech engine is not installed (no ${entry}).` };
    }
    if (!existsSync(this.modelPath)) {
      return { available: false, reason: `The speech model is missing (no ${this.modelPath}).` };
    }
    const expected = this.expectedModelSize();
    const size = statSync(this.modelPath).size;
    if (expected !== null && size !== expected) {
      return {
        available: false,
        reason: `The speech model at ${this.modelPath} is ${size} bytes, expected ${expected}; reinstall the app.`,
      };
    }
    return { available: true, model: "whistle" };
  }

  /** Transcribes 16 kHz mono samples in [-1, 1]; loads the model on the first call. */
  async transcribe(samples: Float32Array, language?: VoiceLanguage): Promise<VoiceTranscript> {
    if (!(samples instanceof Float32Array)) throw new Error("Audio must be a Float32Array.");
    if (samples.length === 0) throw new Error("The recording is empty.");
    if (samples.length > VOICE_SAMPLE_RATE * VOICE_MAX_SECONDS) {
      throw new Error(`Recordings are limited to ${VOICE_MAX_SECONDS} seconds.`);
    }
    if (language !== undefined && !VOICE_LANGUAGES.includes(language)) {
      throw new Error(`Unsupported language ${language}.`);
    }
    const status = this.status();
    if (!status.available) throw new Error(status.reason);
    const whistle = await this.load();
    const result = await whistle.transcribe(samples, language ? { language } : {});
    return {
      text: result.text.trim(),
      language: result.language,
      durationSeconds: result.durationInSeconds,
    };
  }

  /** Stops the worker; the next transcription loads the model again. */
  async close(): Promise<void> {
    const loading = this.whistle;
    this.whistle = null;
    if (loading) await (await loading.catch(() => null))?.close();
  }

  private load(): Promise<Whistle> {
    if (!this.whistle) {
      const url = pathToFileURL(join(this.packageDir, "dist", "index.js")).href;
      this.whistle = (import(url) as Promise<NeedleModule>).then((module) =>
        module.createWhistle({ modelPath: this.modelPath }),
      );
      // A failed load is not cached, so the next attempt retries.
      this.whistle.catch(() => {
        this.whistle = null;
      });
    }
    return this.whistle;
  }

  private expectedModelSize(): number | null {
    try {
      const manifest = JSON.parse(
        readFileSync(join(this.packageDir, "vendor", "manifest.json"), "utf8"),
      ) as ModelManifest;
      return manifest.speechModel?.size ?? null;
    } catch {
      return null;
    }
  }
}
