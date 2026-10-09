/** Scrub known credential values and common serialized secret fields before exporting. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      value.length >= 8 &&
      /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name)
    )
      result = result.split(value).join("[redacted]");
  }
  return result
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"',}]+/gi,
      "$1[redacted]",
    );
}
