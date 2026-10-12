/** Markdown files imported with `with { type: "text" }` load as their text. */
declare module "*.md" {
  const text: string;
  export default text;
}
