/** Microphone capture for voice input: 16 kHz mono samples, at most 30 seconds per clip. */

export const VOICE_RATE = 16_000;
export const VOICE_MAX_SECONDS = 30;
const MAX_SAMPLES = VOICE_RATE * VOICE_MAX_SECONDS;
const FRAME = 4096;

/** Linear resampling; the engine takes 16 kHz and a device may only offer 44.1 or 48 kHz. */
export function resample(samples: Float32Array, from: number, to = VOICE_RATE): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, samples.length - 1);
    const a = samples[left] ?? 0;
    const b = samples[right] ?? 0;
    out[i] = a + (b - a) * (pos - left);
  }
  return out;
}

/** Joins captured frames, keeping at most `max` samples. */
export function joinFrames(frames: readonly Float32Array[], max = MAX_SAMPLES): Float32Array {
  const total = Math.min(
    max,
    frames.reduce((n, f) => n + f.length, 0),
  );
  const out = new Float32Array(total);
  let at = 0;
  for (const frame of frames) {
    if (at >= total) break;
    const part = frame.subarray(0, total - at);
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The loudness of a frame for the level meter, 0 to 1. */
export function level(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const v of frame) sum += v * v;
  // Speech sits around an RMS of 0.05 to 0.2; scale it so a normal voice fills most of the bar.
  return Math.min(1, Math.sqrt(sum / frame.length) * 5);
}

/** Seconds as m:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const MICROPHONE_BLOCKED =
  "Microphone access is blocked. Allow BAKED to use the microphone in your system settings.";

/** Why the microphone could not start, in words for the composer. */
export function microphoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return MICROPHONE_BLOCKED;
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return `The microphone could not start: ${error instanceof Error ? error.message : String(error)}`;
}

export interface RecorderEvents {
  /** About ten times a second while recording: seconds so far and the current level. */
  onProgress(seconds: number, level: number): void;
  /** The clip reached the 30 second limit; call `stop()` to get it. */
  onLimit(): void;
}

/** One recording from the default microphone. */
export class Recorder {
  private frames: Float32Array[] = [];
  private captured = 0;
  private stopped = false;

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly processor: ScriptProcessorNode,
  ) {}

  static async start(events: RecorderEvents): Promise<Recorder> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    // Chromium resamples to the context's rate; `resample` covers a context that ignores it.
    const context = new AudioContext({ sampleRate: VOICE_RATE });
    const source = context.createMediaStreamSource(stream);
    // ScriptProcessorNode needs no separate worklet module, which the page's CSP would block.
    const processor = context.createScriptProcessor(FRAME, 1, 1);
    const recorder = new Recorder(stream, context, source, processor);
    const limit = VOICE_MAX_SECONDS * context.sampleRate;
    processor.onaudioprocess = (event) => {
      if (recorder.stopped || recorder.captured >= limit) return;
      const frame = new Float32Array(event.inputBuffer.getChannelData(0));
      recorder.frames.push(frame);
      recorder.captured += frame.length;
      events.onProgress(recorder.captured / context.sampleRate, level(frame));
      if (recorder.captured >= limit) events.onLimit();
    };
    source.connect(processor);
    processor.connect(context.destination);
    return recorder;
  }

  /** Stops the microphone and returns the clip as 16 kHz mono samples. */
  async stop(): Promise<Float32Array> {
    const rate = this.context.sampleRate;
    this.cancel();
    const raw = joinFrames(this.frames, VOICE_MAX_SECONDS * rate);
    return joinFrames([resample(raw, rate)]);
  }

  /** Stops the microphone and drops the clip. */
  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.processor.onaudioprocess = null;
    this.source.disconnect();
    this.processor.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    void this.context.close();
  }
}
