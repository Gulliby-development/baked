# baked-telemetry

Anonymous usage beacon sink. A Cloudflare Worker that records one Analytics
Engine data point per session-start and returns 204. **Not** part of the npm
package — this directory is excluded by `package.json#files` (allow-list).

## What it stores

Per ping (all anonymous, allow-listed in `src/index.ts`):
`event, surface, os, arch, version, install, model-family, country, provider,
model` + a stable random install id (the dedup key). Provider is the built-in
provider id or `custom`. Model is sent only when it matches a known public-model
pattern under a built-in provider (see `telemetryModelInfo` in
`src/core/llm/provider-options.ts`); any free-form/custom model string — even
under a real provider prefix — collapses to `other`, so it can never carry
secrets, org, or project names. No prompts, paths, keys, IPs, or PII.

## Deploy

```sh
wrangler deploy
```

Routes to the custom domain `t.baked.baked.com` (set in
`wrangler.toml`); the public `*.workers.dev` URL is disabled so the account
subdomain isn't exposed. The client default endpoint lives in
`src/core/telemetry.ts` (`DEFAULT_ENDPOINT`); override at runtime with
`BAKED_TELEMETRY_URL`.

## Query active users

Analytics Engine is SQL-queryable via the CF API. The id (`index1`) is a stable
per-install random UUID, so `count(DISTINCT index1)` over any window = unique
installs in that window.

**Daily active users (DAU)** — distinct installs per day:

```sql
SELECT
  toStartOfDay(timestamp) AS day,
  count(DISTINCT index1)  AS dau,
  count()                 AS pings
FROM baked_usage
WHERE timestamp > now() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day DESC
```

**Monthly active users (MAU)** — distinct installs in the last 30 days:

```sql
SELECT count(DISTINCT index1) AS mau
FROM baked_usage
WHERE timestamp > now() - INTERVAL '30' DAY
```

**Total unique installs (all time):**

```sql
SELECT count(DISTINCT index1) AS unique_installs
FROM baked_usage
```

**Weekly retention** — installs seen this week that were also seen last week:

```sql
SELECT count(DISTINCT index1) AS retained
FROM baked_usage
WHERE timestamp > now() - INTERVAL '7' DAY
  AND index1 IN (
    SELECT index1 FROM baked_usage
    WHERE timestamp BETWEEN now() - INTERVAL '14' DAY AND now() - INTERVAL '7' DAY
  )
```

Breakdown by provider / model:

```sql
SELECT blob9 AS provider, blob10 AS model,
       count(DISTINCT index1) AS installs
FROM baked_usage
WHERE timestamp > now() - INTERVAL '7' DAY AND blob9 != ''
GROUP BY provider, model
ORDER BY installs DESC
```

Blob column order (from `writeDataPoint` in `src/index.ts`):
`blob1=event, blob2=surface, blob3=os, blob4=arch, blob5=version,
blob6=install, blob7=family, blob8=country, blob9=provider, blob10=model`.
`index1` = client id.

## Abuse posture

Defense in depth — write-only into Analytics Engine (no DB to read back,
corrupt, or exfiltrate), plus:

1. **Strict validation — reject, don't coerce.** Every field must match an
   exact allow-list (`os`, `arch`, `surface`, `event`, `install`, `family`) or
   a shape regex (`version` = semver, `id` = UUIDv4). A ping that fails *any*
   check is dropped — never recorded. A real client always passes, so there are
   no false negatives; malformed or hand-crafted junk simply doesn't count.
   Failures return a silent 204 (no 400) so nothing leaks about what was wrong.
2. **Per-IP rate limit.** CF's native rate-limiting binding caps each source
   IP (60 req / 60s). The IP is a limiter *key* only — never written to the
   dataset.
3. **User-Agent gate.** Requests without the `baked/<version>` marker get a
   silent 204 and are never recorded — drops browser/scanner noise. (UAs are
   spoofable, so this is a filter, not a boundary; the items above are the real
   defense.)
4. **Query-time dedup.** Counts are `DISTINCT` on the random install id, so any
   residual duplicate pings collapse to one.

**What's not achievable:** the endpoint is public and unauthenticated, so a
determined attacker who reads the (open-source) client can still mint
valid-shaped pings with real UUIDs. There is no cryptographic fix — any signing
key would ship in the client. Validation + rate limit + distinct-id dedup make
the dataset clean and cap the blast radius; they don't make spoofing impossible.

No client secret is shipped. The custom-domain URL is public by necessity (the
client must reach it) but exposes nothing — no account id, no key, no PII.
