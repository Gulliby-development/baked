import { createContext, memo, useContext, useMemo } from "react";
import { useTheme } from "../../core/theme/index.js";
import { getSyntaxStyle, getTSClient } from "../../core/utils/syntax.js";

const CodeExpandedContext = createContext(false);
export const CodeExpandedProvider = CodeExpandedContext.Provider;
export function useCodeExpanded(): boolean {
  return useContext(CodeExpandedContext);
}

/** Verbose mode — when true, system-reminder tags in assistant output are rendered
 *  as styled blockquotes. When false (default), they're stripped entirely. Set at the
 *  tab level via <VerboseProvider> based on config.verbose. */
const VerboseContext = createContext(false);
export const VerboseProvider = VerboseContext.Provider;
export function useVerbose(): boolean {
  return useContext(VerboseContext);
}

/** Handles `<system-reminder>...</system-reminder>` tags in assistant output.
 *  Verbose on → render as styled blockquote. Verbose off → strip entirely.
 *  The model (or provider proxies) echoes these as self-memos; showing raw XML
 *  looks broken, showing the content itself is noise for most users.
 *  Only applied to assistant-origin text — if a user types the tag, it stays literal. */
const SYSTEM_REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
function handleSystemReminders(text: string, verbose: boolean): string {
  if (!verbose) {
    // Strip the tag and any trailing whitespace/newlines it leaves behind
    return text
      .replace(SYSTEM_REMINDER_RE, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return text.replace(SYSTEM_REMINDER_RE, (_, body: string) => {
    const lines = body.trim().split("\n");
    const quoted = lines.map((line) => `> ${line}`).join("\n");
    return `> ⚙ **system reminder**\n${quoted}`;
  });
}

interface Props {
  text: string;
  streaming?: boolean;
  /** Origin of the text — only "assistant" gets tag transforms. Defaults to "assistant"
   *  since every current call site renders assistant content. */
  role?: "assistant" | "user";
}

export const Markdown = memo(function Markdown({ text, streaming, role = "assistant" }: Props) {
  const t = useTheme();
  const verbose = useVerbose();
  const syntaxStyle = getSyntaxStyle();
  const tsClient = getTSClient();

  const content = useMemo(
    () => (role === "assistant" ? handleSystemReminders(text, verbose) : text),
    [text, role, verbose],
  );

  const tableOptions = useMemo(
    () => ({
      widthMode: "content" as const,
      wrapMode: "word" as const,
      borders: true,
      borderStyle: "rounded" as const,
      borderColor: t.textFaint,
      cellPadding: 0,
    }),
    [t.textFaint],
  );

  return (
    <markdown
      content={content}
      syntaxStyle={syntaxStyle}
      treeSitterClient={tsClient}
      conceal
      streaming={streaming}
      tableOptions={tableOptions}
    />
  );
});
