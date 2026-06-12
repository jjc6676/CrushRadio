# CLAUDE.md

Crush Radio is a Cloudflare Workers app that runs weekly live music transmissions:
artists upload originals during a submission window, the owner curates a setlist,
everyone hears one synced Friday-night broadcast, listeners tap CRUSHED IT, and the
top third survive into the Hall of Crush. Between transmissions the station is dark.

Specs live in `docs/specs/` — **the latest spec wins**. The state machine and
T001 parameters are in `2026-05-17-transmissions-design.md` (supersedes the 24/7
jukebox design); the automated pipeline + the "why this shape" constitution are in
`2026-06-11-open-signal.md`. Owner operations are in `docs/runbook-t001.md`. Read
the relevant spec before changing the state machine or the pipeline.

## The flow (end to end)

One weekly ritual, three actors. The spine is the six-state cycle, derived from the
active transmission's UTC timestamps (CT shown below is presentation only):

```
Mon 12pm ─ submissions_open ─ Thu 8pm ─ submissions_closed ─ Fri 12pm
   ─ setlist_published ─ Fri 8pm ─ live ─ Fri 10pm ─ results ─ Sat 12pm ─ dark ─ (Mon)
```

**Listener** (anonymous; no account). Lands on `/` → the hero states the premise,
the "How it works" section makes the ritual legible, the transmission panel shows
the current state, the Hall of Crush shows past survivors. Dark → countdown +
add-to-calendar (`.ics`). Submissions open → watches the pool counter. Setlist
published → reads the setlist, counts down. Live (Fri 8pm) → Tune In → wall-clock
synced player → taps CRUSHED IT per track. Results (Fri 10pm) → tallies +
on-demand replay. Hall of Crush is permanent and replayable.

**Artist** (identity = email + a private token; no account). Submissions open →
uploads a file or a URL + attestation + AI disclosure → gets a private status link
(`/track/:id/:token`). Curation → status reads "held" (selection stays secret).
Publish (Fri 12pm) → email: selected (slot + promo line + `.ics`) or held (rolls
over once, then expires with a resubmit invite); status page reveals. Selected →
shares the `#artist-slug` deep link → airs. Results → email: crushed (→ Hall) /
retired / unjudged (resubmit).

**Owner** (single; auth = KV `config:owner_token`). `npm run tx:schedule` applies
the week. Curates Thu→Fri in `/studio` (audition, select, order). Locks — or the
cron auto-locks at Fri noon — which composes the notifications (held until
publish). Broadcast night: hands off; the cron kicks the Rotator. Fri 10pm: the
cron certifies (Wilson survival), writes results, queues results emails. Emergency
only: remove a track (rights/abuse/tech) in `/studio`, which re-kicks the Rotator.
Then schedule the next transmission.

**Public surfaces:** `/` (home), `/transmissions/:n` (+`.ics`), `/track/:id/:token`
(private), `/about`, `/copyright`, `/studio?key=` (owner). The home page is the hub;
everything else is reachable from it or from an email.

## Commands

```bash
npm install
npm run dev                    # build + wrangler dev on :8787 (predev hook builds)
npm run dev -- --test-scheduled   # also exposes /__scheduled for cron testing
npm test                       # node --test (state machine + survival rule)
npm run build                  # inline index.html + web/app.js → workers/main/index.built.js
npm run db:schema:local        # full schema into local D1 (fresh installs)
npm run db:seed:local          # dev data; opens a T001 submission window 1h in the past
npm run db:migrate             # one-time additive migration for pre-pivot remote DBs
npm run tx:schedule            # print weekly-cycle SQL for the next transmission (CT → UTC ms)
npm run deploy                 # production (crushradio.com) — see Deploy below first
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # fire the cron once in dev
```

To walk the six states locally, shift the T001 row's timestamps — copy-paste SQL is in
the runbook under "Testing states locally". All six UI states also render with zero
data via demo mode: `/#demo=dark|submissions_open|submissions_closed|setlist_published|live|results`.

## Architecture

One Worker, one Durable Object, four bindings (D1 `DB`, KV `KV`, R2 `AUDIO`, DO `ROTATOR`):

- `workers/main/index.js` — routing + `scheduled()`. Contains the `__HTML__` and
  `__APP_JS__` placeholders that `scripts/build.mjs` fills to produce
  `index.built.js` (the wrangler entry). **Never edit `index.built.js`** — it is
  generated and gitignored; a fresh clone must `npm run build` before `wrangler dev`.
- `workers/main/state.js` — the six-state machine, signal floor, and survival rule.
  **Pure functions only.** It is imported by `node --test` and by the Rotator, so it
  must never touch Workers APIs, bindings, or `Date.now()` internally.
- `workers/main/api.js` — upload (file or fetch-by-URL, magic-byte sniffed,
  honeypot-gated)/vote/flag/state/hall/audio handlers + `hydrateSetlist` +
  `lockSetlist` (shared by /studio and the auto-lock cron) + `requireOwner`.
- `workers/main/studio.js` — the `/studio` owner console and its POST API
  (curate/lock/unlock/remove/notify). Auth is the KV `config:owner_token`
  compared in `requireOwner`; there are no accounts.
- `workers/main/notify.js` — artist email composition (selected/held/results),
  the idempotent outbox, and Resend delivery (KV `config:resend_key`).
- `workers/main/certify.js` — the cron's jobs, every minute: auto-lock the
  setlist at publish time, kick the Rotator during the live window
  (idempotent), certify results once after broadcast end, flush the outbox.
- `workers/main/pages.js` — server-rendered `/transmissions/:n` (pending →
  setlist with `#artist-slug` anchors → results table), the private
  `/track/:id/:token` artist status page, the `.ics` calendar feed, and the
  static `/about` + `/copyright` pages (`pageShell()` is the shared chrome).
- `web/app.js` — the client app: renders the transmission section from
  `GET /api/state` and drives the state-aware jump-nav label. The static
  "How it works" section + footer live in `index.html`.
- `rotator/index.js` — the Rotator DO: plays the setlist in order during the
  broadcast window, self-syncs from the wall clock after restarts, records
  listener-seconds (`track_listens`) for the signal floor, hibernates after.
  It is awake roughly two hours per week; keep it that way.
- `infra/schema.sql` is canonical for fresh databases; existing databases take
  additive files in `infra/migrations/` (0002 transmissions, 0003 Open Signal,
  0004 review hardening). `infra/seed.sql` is local-dev only.

Owner config lives in KV (`config:*`), never in bindings: `config:owner_token`
(studio auth), `config:resend_key` (email delivery; mailto fallback when unset),
`config:mail_from`, `config:max_submissions_per_window`.

## Invariants — the rules that keep the system honest

1. **State is derived, never stored.** The six states come from the active
   `transmissions` row's UTC timestamps. Do not add a state column; do not let an
   owner action "transition" the station. Every write route re-derives state
   server-side and returns 410 outside its window (upload → `submissions_open`,
   vote → `live`); `/api/flag` works in every state.
2. **All D1 timestamps are UTC milliseconds.** CT ("Friday 8pm CT") is presentation
   only — format with `Intl.DateTimeFormat` + `America/Chicago`, never offset math.
3. **`setlist_json` stores only `[{position, track_id}]`.** Titles, artists, slugs,
   and durations are always joined fresh from D1 via `hydrateSetlist` — never trust
   or denormalize them into the JSON.
4. **Votes travel over `POST /api/vote`, never the WebSocket.** Dedup is the KV key
   `vote:<transmission>:<track>:<fingerprint>`; fingerprint = SHA-256(IP|UA).
5. **No attestation, no upload.** The exact sentence lives in `api.js`
   (`ATTESTATION_TEXT`); the API rejects uploads without it regardless of UI.
6. **The Rotator's DB writes are best-effort.** Listener accounting and play logs
   must never block or crash the broadcast — keep the try/catch swallows.
7. **Audio gating:** `crushed` tracks stream forever; setlist tracks stream only
   while their transmission is `live` or `results`. Everything else is 403.
8. **The setlist locks at Friday noon CT** — by the owner in /studio or by the
   auto-lock cron, whichever comes first. Post-lock removal happens only for
   rights violations, abuse, or technical failure (runbook) — removed tracks go
   back to `held`, never `retired`.
9. **Keep it one Worker.** Modules under `workers/main/` are fine; new Workers are
   not (the lone exception is the disposable `crushradio-preview`).
10. **Selection is secret until publish.** The artist status page and emails must
    not reveal `selected` before `setlist_publish_at` — the artist email and the
    public setlist drop simultaneously.
11. **Notification plumbing never blocks the pipeline.** Outbox writes are
    idempotent (unique on kind+transmission+track) and wrapped in
    try/catch; a failed email must never fail a lock or certification.
12. **No ingestion without a recognized audio signature.** Both upload paths
    (file and fetch-by-URL) go through `sniffAudio`; the extension allowlist
    alone is not a gate. Owner-only access (`requireOwner`) reads the token
    from KV `config:owner_token`; config lives in KV (`config:*`), not in
    bindings, so deploys never need binding changes.

## Verification — required before declaring work done

- **UI changes must be verified in a rendered browser**, not by reading code. If
  screenshot tooling hangs (it does sometimes), fall back to DOM queries
  (`preview_eval`): check the expected elements, measure layout, confirm zero
  console errors.
- **After removing or renaming anything, grep for dangling references** before
  committing. A removed variable that something still imports becomes a 500 in
  production; this repo has been bitten before.
- `npm test` must pass; if you touch `state.js`, extend `tests/state.test.mjs` in
  the same change.
- For lifecycle changes, walk the affected states locally (shift the T001 row, fire
  `/__scheduled`, inspect `transmission_results`) rather than reasoning from code.

## Deploy

- **Preflight auth before writing any code you intend to ship.** A stale
  `CLOUDFLARE_API_TOKEN` env var silently shadows a working `wrangler login` OAuth —
  error 10000 means the env token is dead; clear it for the session
  (`$env:CLOUDFLARE_API_TOKEN = $null` in PowerShell) and retry. A failing
  `wrangler whoami` membership check is benign with scoped tokens; `account_id` is
  pinned in `wrangler.toml`.
- `npm run deploy` ships production (crushradio.com + www via custom domains).
  Cron triggers only run on the deployed version.
- **Cloudflare does not generate version preview URLs for Workers with Durable
  Objects** — `wrangler versions upload` will never yield a working preview here.
  For a shareable preview, deploy a separate `crushradio-preview` Worker (same
  bindings, its own DO namespace, **no cron schedules**) and delete it after review.
- Remote schema changes must be additive-only migrations in `infra/migrations/`
  while the site is live; the running Worker must tolerate both schema versions.

## Gotchas

- D1 has no `generate_series` — use `WITH RECURSIVE seq(v) AS (...)` for test rows.
- CSP is strict: `script-src 'self'`, so **no inline `<script>`** in `index.html` —
  client code goes in `web/app.js` (served at `/assets/app.js`). The WebSocket
  origins are whitelisted explicitly, including `ws://localhost:8787`; changing the
  dev port breaks the live player locally.
- Windows/PowerShell: pass JSON bodies to `curl.exe` via `--data "@file"` (inline
  quoting gets mangled); `$home` is a read-only automatic variable; never pipe
  `git commit` to `Out-Null` — it swallows failures.
- The legacy `tracks.status` column is kept in sync with `track_status` for
  back-compat; new code reads `track_status` only.
