import { createWorkerHandler } from "../../src/core/workers/rpc.js";
import { WorkflowFault } from "../../src/core/workflows/errors.js";
import { recoveryAdvice } from "../../src/core/workflows/remedies.js";

let initConfig: Record<string, unknown> | null = null;

const ctx = createWorkerHandler(
  {
    echo: (x: unknown) => x,
    add: (a: unknown, b: unknown) => (a as number) + (b as number),
    fail: () => {
      throw new Error("intentional error");
    },
    failRecovery: () => {
      throw new WorkflowFault("STALE_DECISION", recoveryAdvice("baked workflow resume RUN", "The run needs a retry.", { action: "resume", runId: "RUN" }));
    },
    failCustom: (msg: unknown) => {
      throw new Error(msg as string);
    },
    sleep: (ms: unknown) =>
      new Promise((resolve) => setTimeout(resolve, ms as number, "done")),
    emitEvent: (event: unknown, data: unknown) => {
      ctx.emit(event as string, data);
      return "emitted";
    },
    callbackTest: async (name: unknown, data: unknown) => {
      return ctx.requestCallback(name as string, data);
    },
    getInitConfig: () => initConfig,
    identity: (...args: unknown[]) => args,
    crash: () => {
      process.exit(1);
    },
  },
  (config) => {
    initConfig = config;
  },
);
