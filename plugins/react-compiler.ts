import { plugin } from "bun";

/**
 * The React Compiler for the UI sources a `bun` process loads from this checkout. `src/core/` holds
 * no component or hook (tests/react-compiler-scope.test.ts keeps it so), and it is about 85% of
 * `src/` with the 1 MB `scheduler.ts`. Babel parsing it added about 8 s to the start of every
 * test fixture child that imports the workflow core, and 55 s on a loaded macOS runner, where it
 * outran the fixture's timeout (#1919). The lookahead keeps any path under `src/core/` out.
 */
const REACT_COMPILER_FILTER = /^(?!.*\/src\/core\/).*\/src\/.*\.tsx?$/;

plugin({
  name: "react-compiler",
  setup(build) {
    build.onLoad({ filter: REACT_COMPILER_FILTER }, async ({ path, loader }) => {
      const { transformSync } = await import("@babel/core");
      const source = await Bun.file(path).text();
      const result = transformSync(source, {
        filename: path,
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
        parserOpts: {
          plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
        },
      });
      return { contents: result?.code ?? source, loader };
    });
  },
});
