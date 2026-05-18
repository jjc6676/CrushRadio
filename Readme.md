# Crush Radio

**An open-source community radio station. Artists upload originals. Everyone tunes in to the same live broadcast. Listeners tap CRUSHED IT on the tracks worth keeping — silence retires the rest.**

Live at [crushradio.com](https://crushradio.com).

> Built by the people who'd actually listen. Voted on by the people actually listening.

## What this is

Crush Radio is a community-built radio station designed around three rules:

1. **One shared broadcast** — every listener hears the same track at the same moment. No personalized streams. Tuning in means tuning in *with* people.
2. **Positive-only voting** — there is no skip button. Listeners tap CRUSHED IT on what they love; silence retires the rest. Tracks that earn love stay in rotation; tracks that don't drop out.
3. **Built in public** — no labels, no algorithm, no closed doors. Every change is a pull request. Every decision is in an issue or a commit message.

Full design lives in [docs/specs/2026-05-17-crush-radio-design.md](docs/specs/2026-05-17-crush-radio-design.md).

## Status

**Plan 1 — shipped:** Cloudflare infrastructure (D1, KV, R2, Durable Object) wired up, Rotator DO live with synced-jukebox WebSocket broadcast, home page deployed to crushradio.com with live GitHub feed.

**Plan 2 — next:** Upload page (drag-drop original audio + R2 write), vote API (`/api/vote`), flag API, DMCA takedown form.

**Plan 3 — after that:** Listener page (the actual TUNE IN experience, CRUSHED IT button wired to the API), artist profile pages.

**Plan 4 — polish:** Donation jar (Stripe Checkout), CONTRIBUTING.md, production deploy hardening.

**Deferred (v2+):** listener accounts/OAuth, artist tip jar, live chat, scheduled shows, federation, mobile app.

## Stack

- **Cloudflare Workers** — page serving + API endpoints (one Worker, one file at `workers/main/index.js`)
- **Durable Object** — the Rotator, the single conductor coordinating shared playback. Maintains current track state, accepts hibernatable WebSocket connections from every listener, and uses DO Alarms to advance tracks
- **R2** — audio storage. Egress to Cloudflare CDN is free, so 1,000 listeners playing the same track ≈ 1 R2 read
- **D1** — tracks, artists, plays, votes, flags (SQLite)
- **KV** — vote dedup by fingerprint, rate limit counters

Estimated cost at a few thousand DAU: **$5–15/month**. Donation jar covers it.

## Repo layout

```
crushradio/
├── index.html              — the static home page shell (hero + feed marker)
├── workers/main/index.js   — main Worker: routing, GitHub feed render
├── rotator/
│   ├── index.js            — Rotator Durable Object (WebSocket + alarm)
│   └── queue.js            — cool-down + priority queue logic
├── infra/
│   ├── schema.sql          — D1 schema (artists, tracks, plays, votes, flags)
│   └── seed.sql            — 3 test tracks for local dev
├── scripts/build.mjs       — inlines index.html into workers/main/index.built.js
├── wrangler.toml           — Cloudflare bindings + custom domains
└── docs/                   — specs, plans, design history
```

## Local development

```bash
npm install
npm run db:schema:local    # apply schema to local D1
npm run db:seed:local      # seed 3 test tracks
npm run dev                # wrangler dev on http://localhost:8787
```

Then in a second terminal:

```bash
curl http://localhost:8787/api/status         # now-playing JSON
npx wscat -c ws://localhost:8787/ws           # WebSocket — receives broadcasts
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
