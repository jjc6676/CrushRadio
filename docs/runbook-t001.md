# Owner Runbook

How to run a transmission. Almost everything now happens in **/studio** —
the token-gated owner console — or happens automatically on the cron.
Raw SQL remains as the break-glass appendix at the bottom.

## 0. One-time setup

**Studio key** — generate a long random token and store it in KV:

```bash
npx wrangler kv key put "config:owner_token" "<long-random-token>" --namespace-id a0a85a30bb8e44069b53704d887e0e30 --remote
```

The console is then at `crushradio.com/studio?key=<token>`. The URL is the
auth — treat it like a password. (Local dev uses the `preview_id` KV
namespace: `7a73730a616a48d4b5a587fb5202fb59` with `--local`.)

**Automated email (optional, recommended by T003)** — create a Resend
account, verify the `crushradio.com` sending domain (SPF + DKIM records),
then:

```bash
npx wrangler kv key put "config:resend_key" "re_..." --namespace-id a0a85a30bb8e44069b53704d887e0e30 --remote
```

The cron flushes the outbox automatically from then on. Without a key,
every notification appears in /studio as a prefilled one-click
`mailto:` link — composition is automated either way, only delivery is
manual. Optional `config:mail_from` overrides the default
`Crush Radio <transmissions@crushradio.com>`.

## 1. Schedule the transmission

```bash
npm run tx:schedule                       # next FULL weekly cycle
npm run tx:schedule -- T002 2026-06-26    # explicit transmission + broadcast Friday
```

Apply the printed SQL via a file:

```bash
node scripts/schedule-transmission.mjs > t001.sql
npx wrangler d1 execute crushradio --remote --file t001.sql
```

(On Windows PowerShell, `>` writes UTF-16 which wrangler reads as garbage —
use `cmd /c "node scripts\schedule-transmission.mjs > t001.sql"` instead.)

The site flips to `submissions_open` automatically at Mon 12pm CT — state
is derived from the timestamps, nothing else to turn on.

## 2. Curate (Thu 8pm → Fri 12pm CT) — in /studio

Open `/studio?key=…`. The pool lists every held track with an inline
player (the studio key unlocks audition audio), flag counts, rollover
badges, and the artist's outbound link.

- **Select** with the checkbox. Target 20–25.
- **Order** with the position inputs (1 airs first). Unnumbered selected
  tracks follow in upload order.
- Anything with a ⚑ flag deserves a listen with the rights attestation in
  mind before selecting.

## 3. Lock the setlist

Click **Lock setlist** when you're done. If you don't, the cron locks it
automatically at Fri 12pm CT (setlist publish) from whatever is selected.
Either way:

- `setlist_json` is written, capped at 25 (overflow returns to held)
- selected + held notification emails are composed into the outbox
- the public setlist page goes live at publish time with `#artist-slug`
  deep links
- artist status pages reveal selection **only after publish** — the email
  and the public drop are simultaneous by design

**Unlock** is available only before publish. After publish, the only edit
is **emergency remove** (rights violation, abuse, or technical failure) —
the track returns to `held`, never `retired`.

## 4. Notifications

With `config:resend_key` set: the cron sends everything within a minute or
two. Without it: /studio shows each pending email as an **open email**
mailto link (subject and body prefilled) — click, send, **mark sent**.

Results emails queue automatically at certification (step 6).

## 5. Broadcast night (Fri 8pm CT) — touch nothing

The cron kicks the Rotator at 8:00pm, the setlist plays in order, votes
land via `/api/vote`. If the DO restarts it re-syncs from the wall clock.
Owner's job: tune in like everyone else.

## 6. Certification (Fri 10pm CT — automatic)

Within a minute of `broadcast_end_at` the cron computes eligibility and
crush rate, writes `transmission_results`, flips each track to
`crushed` / `retired` / `unjudged`, and queues a results email per artist.
The verdicts table appears in /studio and on `/transmissions/001`.

**Escape valve** — if attendance was too small and everything came back
`unjudged`, manually certify winners (T001 only; see appendix SQL).

## 7. After (Sat 12pm CT)

Replay disappears and the station goes dark on its own. The Hall of Crush
stays up forever. Schedule the next transmission (step 1) whenever ready.

---

## Appendix A — Testing states locally

```bash
npm run db:schema:local && npm run db:seed:local && npm run dev
npx wrangler kv key put "config:owner_token" "test-token" --namespace-id 7a73730a616a48d4b5a587fb5202fb59 --local
```

The seed opens T001 submissions one hour in the past; /studio?key=test-token
works immediately. Time-travel by shifting the row, e.g. jump to the live
window:

```sql
UPDATE transmissions SET
  submission_open_at  = strftime('%s','now')*1000 - 96*3600000,
  submission_close_at = strftime('%s','now')*1000 - 24*3600000,
  setlist_publish_at  = strftime('%s','now')*1000 -  8*3600000,
  broadcast_start_at  = strftime('%s','now')*1000 -      60000,
  broadcast_end_at    = strftime('%s','now')*1000 + 2*3600000,
  replay_close_at     = strftime('%s','now')*1000 + 16*3600000
WHERE id = 'T001';
```

(Local cron doesn't fire on a timer — trigger it once with
`curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` after starting
`wrangler dev --test-scheduled`.)

The six UI states preview with zero data via demo mode:
`/#demo=dark`, `/#demo=submissions_open`, `/#demo=submissions_closed`,
`/#demo=setlist_published`, `/#demo=live`, `/#demo=results`.

## Appendix B — Break-glass SQL

Everything /studio does, by hand (`npx wrangler d1 execute crushradio
--remote --command "<sql>"`):

```sql
-- See the pool
SELECT t.id, a.name, t.title, t.duration_s, t.flag_count, t.rollover_count
FROM tracks t JOIN artists a ON a.id = t.artist_id
WHERE t.track_status = 'held' ORDER BY t.uploaded_at;

-- Select / deselect
UPDATE tracks SET track_status = 'selected' WHERE id IN ('<id1>','<id2>');
UPDATE tracks SET track_status = 'held' WHERE id = '<id>';

-- Lock by hand (positions from curation_position, else upload order)
UPDATE transmissions SET setlist_json = (
  SELECT json_group_array(json_object('position', rn, 'track_id', id))
  FROM (SELECT t.id, ROW_NUMBER() OVER (ORDER BY COALESCE(t.curation_position, 9999), t.uploaded_at) AS rn
        FROM tracks t WHERE t.track_status = 'selected' LIMIT 25)
), updated_at = strftime('%s','now') * 1000
WHERE id = 'T001';

-- Emergency post-lock removal (rights/abuse/tech only)
UPDATE tracks SET track_status = 'held' WHERE id = '<track-id>';
-- then prune transmissions.setlist_json and renumber positions

-- Manual certification escape valve
UPDATE transmission_results SET status = 'crushed', rank = 1
WHERE transmission_id = 'T001' AND track_id = '<track-id>';
UPDATE tracks SET track_status = 'crushed', status = 'crushed' WHERE id = '<track-id>';

-- Listen to a candidate outside /studio
-- npx wrangler r2 object get crushradio-audio/tracks/<id>.mp3 --file out.mp3
```
