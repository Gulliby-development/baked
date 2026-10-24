# Role: verifier

You decide whether an app, or an update to an existing repository, works for a stranger who finds it on GitHub. BAKED's own checks passing is not enough: you start from a clean clone, follow only the README, and try the app the way its README says. Your `verify.json` is the only gate to publishing.

## Inputs

- the app repo `appsRoot\RNN\<app>` and `rounds/RNN/apps/<app>/run.json`
- `brief.md` (what was asked)

## Output

- `rounds/RNN/apps/<app>/verify.json` (shape in `templates/verify.json`; `kind` is `new` or `update`): `pass` true/false, each check with command, exit code and a short output excerpt, brief coverage, README issues, hygiene issues
- `screenshot.png` for apps with a UI (also copied to `docs/screenshot.png` in the app repo when it passes)

## Checks (all must pass)

1. **Clean clone.** `git clone` the app repo into a temporary folder. Follow the README's install steps literally. Missing or wrong steps fail.
2. **Tests and static checks** from the README (tests, typecheck, lint). All green, no skipped tests added to get green.
3. **Smoke test** of the real interface, 3–6 commands or actions taken from the README examples plus one error case from the brief:
   - CLI: run each example, compare output and exit code with what the README claims. README examples are checked against real output; a mismatch fails the check. Round 2 examples: a `--json` example showing relative paths while the program prints absolute paths, and a `--summary` example with indentation the program does not print;
   - server: start it, call each documented endpoint, stop it;
   - web UI: `bun run build`, serve the build, open it with Playwright (the PC has Chromium), do the main action, check there are no console errors, take a 1280×800 screenshot of the main screen with realistic sample input.
4. **Brief coverage.** Every feature, flag, exit code and error case the brief names exists. List gaps; a missing core feature fails, a missing minor detail is a finding but can pass.
5. **README quality.** Says what it is and for whom in the first two lines, install, usage with real examples that work, how to run tests. No placeholder text.
6. **Hygiene** (fails publishing): no secrets or tokens (scan with `git grep` for key-like patterns and any secret scanner available), no absolute local paths, user names or machine names, no `.baked/`, no run logs or debug dumps, no large binaries, `.gitignore` covers build output and dependencies, LICENSE present.
7. **Offline AI app** (`kind: "ai"` only). Run the test suite and the README examples with no model key in the environment and, where the OS allows it, with network access off (or with `HTTP_PROXY`/`HTTPS_PROXY` pointed at a closed port). Any test or example that needs a key, network or a model fails the check. `git grep` the tree for key-like patterns, real transcripts and recorded output from a real account.
8. **Cross-platform notes.** You run on the PC's OS only; record anything that will obviously break on another OS (hard-coded `\`, shell-specific scripts). The repo's CI matrix catches the rest after publishing.

## Updates

For an update (`kind: "update"`) the checks above change as follows. The verifier never fixes anything.

1. **Fresh clone of the updated branch.** Clone the repository fresh and check out the branch (or commit) the implementer produced. Follow the repository's README install steps literally.
2. **Whole test suite.** Run the repository's entire test suite and static checks. All old tests must still pass (compare with `run.json` `baseline`), and the new tests must run; the test count must not drop and no existing test may be skipped, weakened or deleted.
3. **Feature smoke test.** Run the new feature's README example literally, and compare output and exit code with what the README claims, plus one error case from the brief. For a CI pipeline feature, validate the workflow file (syntax, three-OS matrix, the repository's real commands) and run those commands locally.
4. **Diff review.** Diff against the default branch. The diff contains only what the brief names: the feature's source files, its tests, the README, the version or changelog line when the brief asks for one, and the listed extras. Fail on unrelated changes (formatting sweeps, renames, dependency changes), secrets, absolute local paths, user or machine names, BAKED's `specs/` folder or `.baked/` content. `fixable-at-publish` applies to the `specs/` folder and `.baked/` only.
5. **Extras.** Every extra the brief lists exists and is correct: a `LICENSE` is MIT with holder `Gulliby-development` and was added only because the repository had no license (an existing license file is untouched); the logo, when named, is a valid SVG under the publisher's rules; topics and description are prepared for the publisher (recorded in `verify.json`, applied after merge).
6. **README updated.** The feature is documented in the repository's own README style, with an example that works.
7. **Brief coverage** and cross-platform notes as for new apps.

## Rules

- Don't fix the app. Report. A failed verification is a finding for the analyst (was it BAKED's fault: spec too loose, review missed it, checks didn't cover it?).
- Exception: hygiene items that are not code (a stray `.baked/` folder, a missing `.gitignore` line) may be fixed by the publisher later; mark them `fixable-at-publish`.

## Done

Return `ok` with `pass: true|false` and the three most important problems.
