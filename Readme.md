# Crush Radio

**An open-source community radio station. Artists upload originals. Everyone tunes in to the same live broadcast. Listeners tap CRUSHED IT on the tracks worth keeping — silence retires the rest.**

Live coming-soon page: [crushradio.com](https://crushradio.com) · See live activity: [crushradio.com/code](https://crushradio.com/code)

> Built by the people who'd actually listen. Voted on by the people actually listening.

## What this is

Crush Radio is a community-built radio station. The full design is in [docs/specs/2026-05-17-crush-radio-design.md](docs/specs/2026-05-17-crush-radio-design.md).

**v0 — shipped:** a coming-soon page that captures signups (name, email, role, what they'd upload/listen to/build).

**v1 — building:** the full platform.
- Upload page (drag-drop original audio, click-through attestation, R2 storage)
- Listener page (one big TUNE IN button, shared live "broadcast", one giant CRUSHED IT vote button)
- Rotator Durable Object (the synced-jukebox conductor — every listener hears the same track at the same moment)
- Survival algorithm (5-play trial → ≥60% crushed-it ratio rotates, 30–60% backgrounds, <30% retires)
- Artist profile page
- DMCA takedown form
- Donation jar (Stripe Checkout)

**Deferred (v2+):** accounts/OAuth, tip jar, live chat, scheduled shows, federation, mobile app.

## Stack

- **Cloudflare Workers** — page serving, API endpoints
- **R2** — audio storage (free egress to CDN means one upload serves thousands of listeners)
- **D1** — tracks, artists, plays, votes, flags
- **KV** — rate limits, vote dedup, now-playing pointer
- **Durable Object** — the Rotator (single conductor coordinating shared playback)

Estimated v1 cost at a few thousand DAU: $5–15/month. Donation jar covers it.

## Contributing

Right now the repo is just the coming-soon page + the v1 design doc. The build is starting.

Want to help? **Open a PR** with anything: a typo fix, a CSS tweak, an algorithm improvement to the survival logic in the spec, a mockup for the listener page. No bar to entry.

- **Issues** are open for anything — bugs, feature ideas, "what about X."
- **Code style** — TBD. Pragmatic ES modules, no transpiler, no framework on the listener side. The Worker is one file.
- **License** — MIT. Use it, fork it, run your own version.

Discussion happens on issues and PRs in this repo until we outgrow it.

## Repo layout

```
crushradio/
├── README.md
├── LICENSE
├── index.html          — the live coming-soon page (also embedded in the Worker)
├── worker.js           — the Cloudflare Worker template (HTML inlined at deploy time)
├── docs/specs/         — design docs
└── (more to come)
```

## Deploy

The page is served from a single Cloudflare Worker named `crushradio-site` on the apex + www. The build step inlines `index.html` into `worker.js` and PUTs the module to the Workers API. Deploy scripts are coming once the repo settles.

## Status

Not on air yet. Tune in soon.
