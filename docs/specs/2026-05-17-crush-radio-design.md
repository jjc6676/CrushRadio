# Crush Radio — Design

**Date:** 2026-05-17
**Owner:** J. Chambers (jason.choplin@gmail.com)
**Status:** v0 (coming-soon) shipping. v1 (platform) is the design captured here.

## Vision

Crush Radio is an open-source community radio station. Anyone can upload original music to be heard worldwide. Listeners decide what survives by tapping **CRUSHED IT** or **NEXT** on the live stream. Everyone hears the same broadcast at the same moment — tuning in means tuning in *with* people. Tracks with strong reception get more airtime; tracks that don't land drop out of rotation. Code lives on GitHub. The station runs on listener donations. No ads, no labels, no algorithmic favorites.

> Built by the people who'd actually listen. Voted on by the people actually listening.

## Core decisions (brainstorm outcomes)

| Decision | Choice | Rationale |
|---|---|---|
| Core mechanic | **Open jukebox — everything plays, votes decide survival** | Matches "no gatekeepers" ethos |
| OSS shape | **One canonical station (Lichess model)** | Owner runs crushradio.com; community contributes code via PRs |
| Moderation | **Original work only + DMCA safe harbor** | Click-through attestation at upload. Reactive takedown. Lowest workload. |
| Voting | **Anonymous tap-vote on the player** | One vote per fingerprint+IP per track. No login friction. Tighten later if abused. |
| Listening | **ONE shared live stream** | "We're all listening together" — radio feel, far cheaper than per-listener |
| Monetization | **Pure donation jar (v1)** | Stripe Checkout or Buy Me a Coffee. Layer supporter tier / sponsor reads later. |

## Survival algorithm

- **5-play trial run** for every new track. Plays regardless of votes during trial.
- After play 5, score = `crushed_it / (crushed_it + next)`:
  - **≥ 60%** → `rotating` (replay every 90+ min)
  - **30–60%** → `background` (plays occasionally, low priority)
  - **< 30%** → `retired` (archived on artist profile, not aired)
- Reassessed every 10 plays after — tracks can rise or fall.
- **Cool-downs:** no track within 90 min of itself; no artist within 20 min of themselves.
- **Flags:** 3 within an hour → auto-pulled pending human review.

## Architecture (Cloudflare-native)

```
GitHub: github.com/jchoplin/crushradio (MIT, public)
├─ apps/web        — listener page, upload page, artist profile
├─ workers/api     — REST: upload, vote, flag, donate, takedown
├─ workers/rotator — Durable Object: "the conductor"
└─ infra/          — wrangler.toml, D1 schema, DMCA agent config

Cloudflare runtime:
• Worker (web)    → static pages
• Worker (api)    → JSON endpoints
• Durable Object  → ONE Rotator instance: queue state, current track,
                    started-at ms; broadcasts now-playing over WebSocket
• R2              → audio uploads (public read via audio.crushradio.com)
• D1              → tracks, artists, plays, votes, flags
• KV              → rate-limit counters, fingerprint dedup, hot pointer
```

### The synced-jukebox trick (no real audio stream)

We don't run an HLS broadcast. Instead:

1. Listener connects to Rotator DO via WebSocket.
2. DO replies: `{ track_id, started_at_ms, duration_s }`.
3. Browser fetches `audio.crushradio.com/<track_id>.mp3` (R2 + CDN cache).
4. Browser sets `audio.currentTime = (Date.now() - started_at_ms) / 1000` and plays.
5. On track end, DO advances and pushes the next now-playing payload.
6. Votes POST to `api.crushradio.com/v1/vote` — KV dedupes by fingerprint+IP per track.

**Why this works:** R2 has free egress to Cloudflare CDN, so 1000 listeners playing the same 5MB MP3 = ~1 R2 read. The DO does one transition per ~3 min — basically idle. Estimated v1 cost for a few thousand DAU: **$5–15/month all-in.**

## v0 — Coming-soon page (this week)

- crushradio.com lands with bold/loud landing page (existing file).
- Copy explains the vision: uploads, voting, OSS, donation-funded.
- Signup form: name, email, role (Artist / Listener / Contributor / All), one freeform "what would you upload, listen to, or build?"
- Form posts to `formsubmit.co/jason.choplin@gmail.com` — owner's Gmail.
- Footer: link to (empty) `github.com/jchoplin/crushradio`.
- `/crush-digest` Claude Code slash command reads Gmail and builds a list of submissions.
- Hosting: single Cloudflare Worker serving the static HTML. Custom domain via Worker Custom Domains (auto-DNS + SSL).

## v1 — Launch scope

- Upload page (drag-drop, attestation, R2 + D1 write)
- Listener page (TUNE IN button, now-playing card, two giant vote buttons, flag)
- Rotator Durable Object (survival algorithm, cool-downs)
- Artist profile page (`/a/<slug>` — uploads + status)
- DMCA agent registration + `/takedown` form
- Donate button (Stripe Checkout link)
- About / How it works page
- Public GitHub repo with CONTRIBUTING.md

## Deferred (v2+, on purpose)

- Listener accounts / OAuth (anonymous voting until ballot-stuffing becomes real)
- Artist tip jar
- Live chat alongside broadcast
- Scheduled "shows" / DJ slots
- Federation
- Recommendations
- Mobile app (PWA fine for v1)
- Premium supporter tier
