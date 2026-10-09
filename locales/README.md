# Translating baked

Every word baked shows you lives in this folder. `en.json` is the source, written by
the code. Every other file is a translation of it.

You do not need to know TypeScript to add a language. You need a text editor and a
language you speak well.

## Add a language

1. Copy `en.json` to your language's code. Use the
   [BCP-47 tag](https://en.wikipedia.org/wiki/IETF_language_tag): `ja.json` for Japanese,
   `ar.json` for Arabic, `zh-CN.json` for Simplified Chinese, `pt-BR.json` for Brazilian
   Portuguese.
2. Translate the values. Leave the keys exactly as they are.
3. Run `bun scripts/validate-locales.ts` and fix anything it reports.
4. Open a pull request.

```json
{
  "common.action.cancel": "キャンセル",
  "common.label.files": "ファイル"
}
```

**You do not have to finish.** Translate fifty keys and stop. Anything you leave out
falls back to English, key by key, so a partial translation ships and works. Someone
else — maybe you, later — picks up the rest.

## Rules

**Keep the keys.** The left side of every pair is an address the code looks things up
by. Change it and the text disappears.

**Keep the `{placeholders}`.** `{name}`, `{count}` and friends get replaced with real
values at runtime. Every one in the English string must appear in yours, spelled the
same. You can move them anywhere in the sentence — that is the point of them.

```json
"session.greeting": "Welcome back, {name}"     ← English
"session.greeting": "{name}さん、おかえりなさい"   ← fine, moved to the front
"session.greeting": "おかえりなさい"             ← rejected, {name} is gone
```

**Counting words need `plural`.** English has two forms; your language may have one, or
six. Write the ones your language actually uses, and always include `other`:

```json
"session.steps": "{count, plural, other {# 步}}",
"session.steps": "{count, plural, one {# krok} few {# kroki} many {# kroków} other {# kroku}}",
"session.steps": "{count, plural, zero {لا خطوات} one {خطوة} two {خطوتان} few {# خطوات} other {# خطوة}}"
```

`#` becomes the number, written the way your language writes numbers.

**Do not translate product names.** baked, Claude, OpenAI, GitHub, JSON, API. They stay
as they are.

**Do not paste from a terminal.** Copying text out of a terminal can bring invisible
escape codes with it. The checker rejects those, and it is right to — see below.

**Keep it short.** Much of this text sits in a fixed-width panel. If English says
"Compact", a six-word translation will not fit. Aim for roughly the English length.

## What the checker refuses, and why

Run `bun scripts/validate-locales.ts` before you open a pull request. It fails on:

| It rejects | Because |
|---|---|
| Escape and control characters | A terminal does not *print* these, it *obeys* them. One particular sequence writes to your clipboard. Another repaints the screen, which is enough to fake a confirmation prompt. None of it shows up in a diff. |
| Bidi override characters | They let the text a reviewer reads differ from the text a user sees. Arabic and Hebrew do not need them — the direction comes from the letters themselves. |
| Zero-width and invisible characters | Same problem: things nobody can see in review. |
| A missing or invented `{placeholder}` | The message either loses information or crashes when it is formatted. |
| A plural that lost its `plural` wrapper, or its `other` branch | It would print the word "count" instead of a number, in the one language nobody reviewing can read. |
| Values over 400 characters | At that length it is a payload, not a label. |
| Keys that are not in `en.json` | Stale after a rename, or invented. Either way the code will never read them. |

This is strict because these files come from strangers on the internet and end up
painted into a terminal on someone else's machine. Nothing personal.

## Slash commands in your language

Two kinds of key describe each command:

```json
"command.language.desc": "UI language — pick a bundled translation or follow the system",
"command.language.name": "language"
```

`.desc` is the one-line description shown in the palette — translate it like any other
string. `.name` is the command's **name**: translate it and people can type
`/لغة` instead of `/language` once they turn on *Translated commands* in the language
settings (it is off by default; the English name always works). A name is one word:
letters, digits, `-` or `_`, no spaces, no slash. Hyphenate a two-word command
(`"git stash"` → `"تخزين-مؤقت"`). Leave acronyms alone (`mcp`, `lsp`, `fff`).

## Right-to-left languages

Arabic, Hebrew, Persian and Urdu are welcome. Be aware of where they land:

- **The desktop app** handles right-to-left properly. The layout mirrors.
- **The terminal interface** does not, and cannot — terminals do not reorder
  bidirectional text. Your translation will be correct but the layout around it will
  still read left-to-right.

Translate anyway. The desktop app is the better home for it, and a terminal in your
language beats a terminal in mine.

## Chinese, Japanese, Korean

These characters take **two columns** in a terminal where a Latin letter takes one. The
code accounts for it, so you do not have to. Just keep translations near the English
length in *visual* width — four ideographs occupy about as much room as eight letters.

## When English changes

New keys appear in `en.json` when features are added; keys vanish when a string is
removed. Your file does not need updating immediately — new keys show in English until
someone translates them, and a key English dropped is pruned from your file the next
time `en.json` is published. Run the checker any time to see your coverage:

```
ok    ja        68% translated  (848/1247)
```

## Using a translation before it ships

Every release bundles the catalogs that were here at the time. To use newer ones
without waiting: turn on **Live updates** in the language settings (`/language` in the
terminal, Settings → Language on desktop). baked then fetches this folder straight
from GitHub — checked against the same rules as the pull-request gate before a single
string is shown — and keeps a copy in `~/.baked/locales/`. It is off by default.

## What happens to your pull request

It is merged here, then copied into the private build tree with `bun run locales:sync`,
reviewed once more, and committed. From there it ships in the next release. The commit
your file came from is recorded in `.locales-lock.json`, so the text in any released
binary traces back to the pull request that wrote it.
