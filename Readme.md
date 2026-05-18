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

Crush Radio is in **pre-Transmission 001** build. Infrastructure (Worker, Rotator Durable Object, D1, KV, R2) is live. The transmission state machine, upload route, vote API, setlist page, and results pipeline are the active work.

See [docs/specs/2026-05-17-transmissions-design.md](docs/specs/2026-05-17-transmissions-design.md) for the full architecture and T001 parameters.

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
├── index.html              — the static home page shell (hero + feed marker)
├── workers/main/index.js   — main Worker: routing, GitHub feed render, state-aware routes
├── rotator/
│   ├── index.js            — Rotator Durable Object (WebSocket + alarm)
│   └── queue.js            — setlist playback order
├── infra/
│   ├── schema.sql          — D1 schema
│   └── seed.sql            — test data for local dev
├── scripts/build.mjs       — inlines index.html into workers/main/index.built.js
├── wrangler.toml           — Cloudflare bindings + custom domains
└── docs/specs/             — design specs (latest one wins)
```

## Local development

```bash
npm install
npm run db:schema:local    # apply schema to local D1
npm run db:seed:local      # seed test data
npm run dev                # wrangler dev on http://localhost:8787
```

Then in a second terminal:

```bash
curl http://localhost:8787/api/state          # current state + next transition (UTC ms)
curl http://localhost:8787/api/status         # now-playing JSON
npx wscat -c ws://localhost:8787/ws           # WebSocket — receives broadcasts during live state
```

## Deploy

```bash
npm run deploy             # builds + ships to Cloudflare
```

The Worker is named `crushradio` and serves both `crushradio.com` and `www.crushradio.com` via custom-domain routes declared in `wrangler.toml`. Requires the Cloudflare Workers Paid plan ($5/mo) because Durable Objects.

## Contributing

The build is just starting. Open a PR with anything — typo fix, CSS tweak, algorithm idea, mockup, bug report. No bar to entry.

- **Issues** are open for anything — bugs, feature requests, "what about X."
- **Code style** is pragmatic ES modules. No transpiler, no framework on the listener side. The Worker is one file. Keep it that way unless there's a real reason not to.
- **License:** MIT. Use it, fork it, run your own station.

Discussion happens on issues and PRs until we outgrow it.
