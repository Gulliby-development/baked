import type { DesktopBridge } from "../../shared/bridge.js";
import { createMockBridge, mockScenario } from "./mock.js";

declare global {
  interface Window {
    baked?: DesktopBridge;
  }
}

// Undefined outside a browser, as in a unit test that loads a client module without a `window`.
const host = typeof window === "undefined" ? undefined : window;

/** The preload bridge inside Electron; fixtures in a plain browser. */
export const bridge: DesktopBridge =
  host?.baked ?? createMockBridge(mockScenario(host?.location?.search ?? ""));
export const isMock = host?.baked === undefined;
