/**
 * Turns off the AI SDK's own warning output. It goes to stderr through `process.emitWarning`,
 * which draws over the terminal UI; provider warnings reach BAKED as stream `warning` parts
 * anyway. A global is per thread, so every entry point and worker that runs a model imports
 * this module first.
 */
globalThis.AI_SDK_LOG_WARNINGS = false;
