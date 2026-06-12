# Crush Radio

**Open-source radio for songs algorithms would bury. Artists upload originals. Everyone hears the same broadcast. If listeners tap CRUSHED IT, the track survives. If not, it disappears.**

Live at [crushradio.com](https://crushradio.com).

> Built by the people who'd actually listen. Voted on by the people actually listening.

## What this is

Crush Radio is a community-built radio station run as **weekly live transmissions**, not 24/7 background noise. Each Friday at 8pm CT, a curated setlist of original tracks airs as one shared broadcast. Listeners tap CRUSHED IT on the tracks worth keeping. The top third survive into the **Hall of Crush**. The rest disappear. Between transmissions, the station goes dark.

Three rules:

1. **One shared broadcast** — every listener hears the same track at the same moment. No personalized streams, no skip button. Tuning in means tuning in *with* people.
2. **Positive-only voting** — listeners tap CRUSHED IT on what they love; silence retires the rest. Tracks earn their place or they're gone.
3. **Built in public** — no labels, no algorithm, no closed doors. Every change is a pull request. Every decision is in an issue or a commit message.

Doctrine:

> Early transmissions are hand-curated to establish signal. As the community grows, the protocol opens.
> If nobody shows up live, the track has not truly been judged.

Full design: [docs/specs/2026-05-17-transmissions-design.md](docs/specs/2026-05-17-transmissions-design.md).

## The weekly cycle

| When (CT) | State | What's happening |
|---|---|---|
| Mon 12pm → Thu 8pm | **Submissions open** | Artists upload original tracks. Live submission counter on the site. |
| Thu 8pm → Fri 12pm | **Curation** | Owner picks 20–25 tracks from the pool. Setlist locks Friday noon. |
| Fri 12pm → Fri 8pm | **Setlist published** | Selected artists get a shareable promo card. The site shows the setlist (no audio yet) and counts down to the broadcast. |
| Fri 8pm → ~10pm | **Live transmission** | Everyone tunes in to the same broadcast. CRUSHED IT button on the player. Hall counter ticks up live. |
| Fri 10pm → Sat 12pm | **Results / replay** | Final tallies posted. On-demand replay available with voting closed. |
| Sat 12pm → Mon 12pm | **Dark** | Site is a countdown to the next submission window. Hall of Crush archive is the only other thing visible. |

All timestamps stored in UTC; CT is presentation only.

## Status

Crush Radio is **live and scheduled for Transmission 001** (broadcast Friday June 19, 8pm CT). The whole weekly pipeline is automated around one human decision — the owner's curation taste:

- **Artists** upload a file *or* paste a direct link to one (the Worker fetches and stores a copy). Every submission is magic-byte verified, rights-attested, rate-limited, and honeypot-gated. Each artist gets a **private status link** that tracks their track from pool → setlist → verdict.
- **Curation** happens in `/studio` — a token-gated console with inline audition players, select/order controls, and one-click setlist lock. If the owner oversleeps, the **cron auto-locks** the selected tracks at Friday noon.
- **Notifications** (selected / held / results) are composed automatically into an outbox; they auto-send via Resend when a key is configured, or surface as prefilled one-click mailto links when not.
- **Listeners** get add-to-calendar (`/transmissions/001.ics` with a 30-minute alarm), the synced live player, and outbound **artist links** on the setlist, results, and Hall of Crush — crush a track, find its maker.

See [docs/runbook-t001.md](docs/runbook-t001.md) for operating the station and [docs/specs/2026-05-17-transmissions-design.md](docs/specs/2026-05-17-transmissions-design.md) for the architecture. All six UI states preview without data via demo mode: `/#demo=submissions_open`, `/#demo=live`, `/#demo=results`, etc.

## Stack

- **Cloudflare Workers** — page serving + API endpoints (one Worker at `workers/main/index.js`)
- **Durable Object** — the Rotator, the single conductor coordinating shared playback during the live transmission window. Hibernatable WebSockets, DO Alarms for track advance. Awake ~2 hours per week.
- **R2** — audio storage. Egress to Cloudflare CDN is free, so 1,000 listeners playing the same track ≈ 1 R2 read.
- **D1** — artists, tracks, transmissions, transmission_results, plays, votes, flags (SQLite)
- **KV** — vote dedup by fingerprint, rate limit counters
- **Cron Triggers** — drive state transitions and result certification (UTC)

Estimated cost at a few thousand DAU around transmission windows: **$5–15/month**. Donations cover it.

## Repo layout

```
crushradio/
├── index.html              — the static home page shell (hero + tx section + feed marker)
├── web/app.js              — client app: renders the transmission section from /api/state
├── web/studio.js           — owner console client wiring
├── workers/main/
│   ├── index.js            — main Worker: routing, scheduled() cron, GitHub feed render
│   ├── state.js            — derived state machine + signal floor + survival rule (pure)
│   ├── api.js              — upload (file or URL) / vote / flag / state / hall / audio + setlist lock
│   ├── studio.js           — /studio owner console + curation API (token-gated via KV)
│   ├── notify.js           — artist email composition + outbox + Resend delivery
│   ├── certify.js          — cron jobs: auto-lock, Rotator kick, certification, outbox flush
│   └── pages.js            — /transmissions/:n pages, /track/:id/:token status, .ics calendar
├── rotator/index.js        — Rotator Durable Object: setlist conductor + listener accounting
├── infra/
│   ├── schema.sql          — D1 schema (canonical, fresh installs)
│   ├── migrations/         — additive migrations for existing databases
│   └── seed.sql            — test data for local dev
├── scripts/
│   ├── build.mjs           — inlines index.html + web/app.js into index.built.js
│   └── schedule-transmission.mjs — prints the weekly-cycle SQL (CT → UTC ms)
├── tests/state.test.mjs    — state machine + survival rule tests (node --test)
├── wrangler.toml           — Cloudflare bindings, custom domains, cron trigger
├── docs/runbook-t001.md    — owner runbook: schedule, curate, lock, certify
└── docs/specs/             — design specs (latest one wins)
```

## Local development

```bash
npm install
npm run db:schema:local    # apply schema to local D1
npm run db:seed:local      # seed test data (opens a T001 submission window)
npm run dev                # wrangler dev on http://localhost:8787
npm test                   # state machine + survival rule tests
```

Then in a second terminal:

```bash
curl http://localhost:8787/api/state          # derived state + next transition (UTC ms)
curl http://localhost:8787/api/transmissions/current   # schedule/setlist/results payload
curl http://localhost:8787/api/status         # Rotator now-playing JSON
npx wscat -c ws://localhost:8787/ws           # WebSocket — receives broadcasts during live state
```

To walk the full weekly cycle locally (including the live broadcast and
certification), see "Testing states locally" in [docs/runbook-t001.md](docs/runbook-t001.md).

## Deploy

```bash
npm run preview            # builds + uploads a preview version (shareable URL, prod untouched)
npm run deploy             # builds + ships to production
npm run db:migrate         # one-time: apply the transmissions migration to remote D1
```

The Worker is named `crushradio` and serves both `crushradio.com` and `www.crushradio.com` via custom-domain routes declared in `wrangler.toml`. Requires the Cloudflare Workers Paid plan ($5/mo) because Durable Objects.

## Contributing

The build is just starting. Open a PR with anything — typo fix, CSS tweak, algorithm idea, mockup, bug report. No bar to entry.

- **Issues** are open for anything — bugs, feature requests, "what about X."
- **Code style** is pragmatic ES modules. No transpiler, no framework on the listener side. The Worker is one file. Keep it that way unless there's a real reason not to.
- **License:** MIT. Use it, fork it, run your own station.

Discussion happens on issues and PRs until we outgrow it.
