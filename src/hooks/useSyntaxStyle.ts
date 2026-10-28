import type { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { getSyntaxStyle } from "../core/utils/syntax.js";

/** The code highlighting style of the renderer this component draws in (#2404). */
export function useSyntaxStyle(): SyntaxStyle {
  return getSyntaxStyle(useRenderer().nativeScene);
}
