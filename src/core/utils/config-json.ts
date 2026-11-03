/**
 * Parses the text of a `config.json`. A leading UTF-8 byte order mark is dropped first: Windows
 * PowerShell 5.1 (`Set-Content -Encoding utf8`) and older Notepad write one, and `JSON.parse`
 * rejects it, which stopped startup on a valid global config and dropped a project config (#2728).
 * Every reader of a global or project config file parses through here.
 */
export function parseConfigJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
