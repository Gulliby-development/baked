// `web-tree-sitter-engine` is web-tree-sitter 0.27 under an alias (OpenTUI pins 0.25.10 as
// `web-tree-sitter`). 0.27 ships its types as an ambient `declare module "web-tree-sitter"`, which
// would clash with 0.25's, so the alias reuses 0.25's types: the API the backend calls is the same.
declare module "web-tree-sitter-engine" {
  export * from "web-tree-sitter";
}
