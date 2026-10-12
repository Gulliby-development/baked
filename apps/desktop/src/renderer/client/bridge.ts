import type { DesktopBridge } from "../../shared/bridge.js";
import { createMockBridge, mockScenario } from "./mock.js";

declare global {
  interface Window {
    baked?: DesktopBridge;
  }
}

/** The preload bridge inside Electron; fixtures in a plain browser. */
export const bridge: DesktopBridge =
  window.baked ?? createMockBridge(mockScenario(window.location?.search ?? ""));
export const isMock = window.baked === undefined;
