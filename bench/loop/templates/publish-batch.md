# Publish record RNN

Mode: auto · round started <date>

With `publish.mode` `auto` each app is published right after its `verify.json` passes. Add a row when its repository is public. In `approve-per-round` mode this file is the batch sent to the owner, with an extra line at the end: `Owner's answer: <pending | yes | no | edits> (<date>)`.

| App | Repo | Description | Verified | CI (ubuntu / windows / macos) | Logo | README |
|---|---|---|---|---|---|---|
| envguard | [Gulliby-development/envguard](https://github.com/Gulliby-development/envguard) | Check .env files against .env.example in CI | tests 15/15, 5 smoke checks | pass / pass / pass | model SVG | [README](apps/envguard/publish/README.md) |

Not published:
| App | Why |
|---|---|
