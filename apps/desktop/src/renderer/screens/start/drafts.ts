/**
 * Text typed on one screen that another screen picks up: the chat or coordinator composer, the
 * new run form or the quick task form. Kept in sessionStorage per project, because a query string after
 * the hash route would not survive the router; a screen takes the draft once.
 */

export type DraftTarget = "chat" | "coordinator" | "run" | "quick";

const storageKey = (target: DraftTarget, projectKey: string): string =>
  `baked.draft.${target}.${projectKey}`;

export function putDraft(target: DraftTarget, projectKey: string, text: string): void {
  try {
    if (text.trim()) sessionStorage.setItem(storageKey(target, projectKey), text);
    else sessionStorage.removeItem(storageKey(target, projectKey));
  } catch {
    // Storage can be unavailable; the other screen then starts empty.
  }
}

/** Returns the draft for a screen without forgetting it. */
export function peekDraft(target: DraftTarget, projectKey: string): string {
  try {
    return sessionStorage.getItem(storageKey(target, projectKey)) ?? "";
  } catch {
    return "";
  }
}

/** Returns the draft for a screen and forgets it. */
export function takeDraft(target: DraftTarget, projectKey: string): string {
  try {
    const key = storageKey(target, projectKey);
    const text = sessionStorage.getItem(key) ?? "";
    sessionStorage.removeItem(key);
    return text;
  } catch {
    return "";
  }
}
