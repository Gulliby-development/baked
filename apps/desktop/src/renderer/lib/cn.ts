import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's own radius and shadow names (index.css), so a later `rounded-*` or `shadow-*`
// replaces `rounded-base`, `shadow-shadow` or `shadow-sm-hard` instead of sitting beside it.
const twMerge = extendTailwindMerge({
  extend: { theme: { radius: ["base"], shadow: ["shadow", "sm-hard"] } },
});

/** Joins class names and lets a later Tailwind utility replace a conflicting earlier one. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
