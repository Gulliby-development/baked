const CYRILLIC: Record<string, string> = Object.fromEntries(
  "\u0430:a \u0431:b \u0432:v \u0433:g \u0434:d \u0435:e \u0451:e \u0436:zh \u0437:z \u0438:i \u0439:y \u043a:k \u043b:l \u043c:m \u043d:n \u043e:o \u043f:p \u0440:r \u0441:s \u0442:t \u0443:u \u0444:f \u0445:h \u0446:ts \u0447:ch \u0448:sh \u0449:sch \u044a: \u044b:y \u044c: \u044d:e \u044e:yu \u044f:ya \u0456:i \u0457:yi \u0454:ye \u0491:g"
    .split(" ")
    .map((pair) => pair.split(":") as [string, string]),
);
/** A SafeId-compatible feature id derived from free text; Cyrillic is transliterated. */
export function featureSlug(text: string): string {
  const ascii = [...text.toLowerCase()]
    .map((ch) => CYRILLIC[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return ascii || `feature-${Date.now().toString(36)}`;
}
export const isFeatureId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id);

/**
 * The feature ID of a quick task: the slug of its text, with -2, -3, ... appended while `taken`
 * says a run already uses the ID, so every quick task is listed and measured on its own.
 */
export function uniqueFeatureId(text: string, taken: (id: string) => boolean): string {
  const base = featureSlug(text);
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base.slice(0, 90)}-${n}`;
    if (!taken(id)) return id;
  }
  return `${base.slice(0, 80)}-${Date.now().toString(36)}`;
}
