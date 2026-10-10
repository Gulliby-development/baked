import type { DesktopBridge } from "../../shared/bridge.js";
import { createMockBridge } from "./mock.js";

declare global {
  interface Window {
    baked?: DesktopBridge;
  }
}

/** The preload bridge inside Electron; fixtures in a plain browser. */
export const bridge: DesktopBridge = window.baked ?? createMockBridge();
export const isMock = window.baked === undefined;
