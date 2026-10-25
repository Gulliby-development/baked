# Vendored tree-sitter grammars

Grammars for languages that `tree-sitter-wasms` (0.1.13) does not bundle. The code intelligence
backend (`src/core/intelligence/backends/tree-sitter.ts`) looks for a grammar here after
`node_modules/tree-sitter-wasms/out`, and the bundles (`scripts/bundle.sh`,
`scripts/bundle-windows.ps1`) and `scripts/postinstall.mjs` copy these files into `~/.baked/wasm`
with the others.

| File | Source | Version | License | How it was made |
|---|---|---|---|---|
| `tree-sitter-sql.wasm` | [DerekStride/tree-sitter-sql](https://github.com/derekstride/tree-sitter-sql), npm `@derekstride/tree-sitter-sql` | 0.3.11 | MIT, `LICENSE-tree-sitter-sql` | built from the npm package's `src/` (see below); the package ships no wasm |

The engine is web-tree-sitter 0.27, which loads grammars of ABI 13 to 15.

## Rebuilding a grammar

```sh
npm pack @derekstride/tree-sitter-sql@0.3.11 && tar xzf derekstride-tree-sitter-sql-0.3.11.tgz
cd package
# tree-sitter-cli 0.26 downloads wasi-sdk itself; 0.25 needs emcc or Docker.
echo '{"grammars":[{"name":"sql","scope":"source.sql","path":".","file-types":["sql"]}],"metadata":{"version":"0.3.11"}}' > tree-sitter.json
npx tree-sitter-cli@0.26.3 build --wasm -o tree-sitter-sql.wasm .
```

A new grammar gets a row here, its license file, a `GRAMMAR_FILES` entry and query in
`tree-sitter.ts`, and a symbol-extraction case in the language's fixture
(`tests/fixtures/languages/<language>.json`, the `callGraph` golden).
