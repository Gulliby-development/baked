# Round 1 briefs

The owner approved these five apps on 2026-10-10. Round 1 of the loop uses each brief verbatim as `rounds/R01/apps/<app>/brief.md`, plus the three lines the reviewer adds to every brief (README, MIT LICENSE, cross-platform).

## envguard

TypeScript CLI on Bun (also runnable with node via a built JS file). Compares .env against .env.example: reports missing keys, extra keys, and empty values; options --strict (extra keys are errors), --json output; exit code 0 ok, 1 problems, 2 usage/IO error. Tests and a README with install and usage examples.

## mdtoc

TypeScript CLI on Bun. Generates a table of contents for a Markdown file from its headings (GitHub-style anchors, duplicate headings get -1/-2 suffixes, headings inside code fences ignored) and writes it between <!-- toc --> and <!-- tocstop --> markers in place; --check mode exits 1 if the TOC is stale (for CI); --max-depth. Tests and README.

## cronsay

React + Vite + TypeScript web app. Input a 5-field cron expression; shows a plain-English description and the next 10 run times in the user's local time zone; validation errors inline; a few example presets. Cron parsing written in the app (no cron library). Unit tests for the parser and next-run calculation (vitest or bun test), README.

## jsondelta

React + Vite + TypeScript web app. Two text areas for JSON A and B; shows a structural diff (added, removed, changed values by JSON path) with color highlighting, parse errors shown per side, a swap button and an "ignore array order" toggle. Diff logic as a pure module with unit tests, README.

## logslice

Python 3.11+ CLI (standard library only, pytest for tests, pyproject.toml with a console script). Reads log files or stdin with lines like "2026-10-10 12:00:00 LEVEL message" (also ISO 8601 with T), filters by --since/--until and --level (minimum level), and --summary prints counts per level and the top 5 most frequent error messages. Tests and README.
