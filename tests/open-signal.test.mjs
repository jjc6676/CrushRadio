// Crush Radio — Open Signal tests: sniffing, setlist ordering, ICS,
// notification composition. Run with: npm test (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffAudio, buildSetlistOrder, isSafePublicHost, validTrackUrl } from "../workers/main/api.js";
import { icsForTransmission } from "../workers/main/pages.js";
import { composeSelected, composeHeld, composeResult } from "../workers/main/notify.js";

const bytes = (...vals) => {
  const arr = new Uint8Array(16);
  vals.forEach((v, i) => {
    arr[i] = typeof v === "string" ? v.charCodeAt(0) : v;
  });
  return arr;
};

test("sniffAudio recognizes real audio signatures and rejects garbage", () => {
  assert.equal(sniffAudio(bytes("I", "D", "3", 4, 0)), "mp3");
  assert.equal(sniffAudio(bytes(0xff, 0xfb, 0x90)), "mp3"); // MPEG frame sync
  const wav = bytes("R", "I", "F", "F", 0, 0, 0, 0, "W", "A", "V", "E");
  assert.equal(sniffAudio(wav), "wav");
  assert.equal(sniffAudio(bytes("f", "L", "a", "C")), "flac");
  assert.equal(sniffAudio(bytes("O", "g", "g", "S")), "ogg");
  assert.equal(sniffAudio(bytes(0, 0, 0, 32, "f", "t", "y", "p")), "m4a");
  assert.equal(sniffAudio(bytes("P", "K", 3, 4)), null); // zip
  assert.equal(sniffAudio(bytes("<", "!", "d", "o")), null); // html
  assert.equal(sniffAudio(new Uint8Array(4)), null); // too short
});

test("isSafePublicHost blocks private/loopback/link-local, allows real hosts", () => {
  for (const bad of [
    "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.3.4", "172.31.255.255",
    "169.254.169.254", "100.64.0.1", "localhost", "foo.internal", "::1",
    "fd00::1", "fe80::1", "0.0.0.0", "224.0.0.1",
  ]) {
    assert.equal(isSafePublicHost(bad), false, `${bad} should be blocked`);
  }
  for (const ok of [
    "crushradio.com", "files.bandcamp.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "example.org",
  ]) {
    assert.equal(isSafePublicHost(ok), true, `${ok} should be allowed`);
  }
});

test("validTrackUrl requires https and a safe host", () => {
  assert.equal(validTrackUrl("http://example.com/a.mp3"), null); // not https
  assert.equal(validTrackUrl("https://169.254.169.254/latest"), null); // metadata
  assert.equal(validTrackUrl("https://localhost/x.mp3"), null);
  assert.equal(validTrackUrl("not a url"), null);
  assert.ok(validTrackUrl("https://artist.bandcamp.com/track.mp3"));
});

test("buildSetlistOrder: owner positions first, upload order for ties, cap 25, renumbered", () => {
  const tracks = [
    { id: "c", uploaded_at: 300, curation_position: null },
    { id: "a", uploaded_at: 100, curation_position: 2 },
    { id: "b", uploaded_at: 200, curation_position: 1 },
    { id: "d", uploaded_at: 50, curation_position: null },
  ];
  const out = buildSetlistOrder(tracks);
  assert.deepEqual(out.map((s) => s.track_id), ["b", "a", "d", "c"]);
  assert.deepEqual(out.map((s) => s.position), [1, 2, 3, 4]);

  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `t${i}`,
    uploaded_at: i,
    curation_position: null,
  }));
  assert.equal(buildSetlistOrder(many).length, 25);
});

const T = {
  id: "T001",
  number: 1,
  submission_open_at: Date.UTC(2026, 5, 15, 17),
  submission_close_at: Date.UTC(2026, 5, 19, 1),
  setlist_publish_at: Date.UTC(2026, 5, 19, 17),
  broadcast_start_at: Date.UTC(2026, 5, 20, 1), // Fri Jun 19 8pm CDT
  broadcast_end_at: Date.UTC(2026, 5, 20, 3),
  replay_close_at: Date.UTC(2026, 5, 20, 17),
};

test("icsForTransmission emits a valid UTC event with a 30-minute alarm", () => {
  const ics = icsForTransmission(T, Date.UTC(2026, 5, 11));
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.includes("DTSTART:20260620T010000Z"));
  assert.ok(ics.includes("DTEND:20260620T030000Z"));
  assert.ok(ics.includes("UID:t001@crushradio.com"));
  assert.ok(ics.includes("TRIGGER:-PT30M"));
  assert.ok(ics.includes("SUMMARY:Crush Radio — Transmission 001 (live)"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  // Every line CRLF-terminated, no bare LF
  assert.ok(!/[^\r]\n/.test(ics));
});

const TRACK = {
  id: "track-x",
  title: "Copper Wires",
  access_token: "aabbccdd",
  artist_name: "Static Bloom",
  artist_slug: "static-bloom",
};

test("composeSelected carries slot, deep link, and the private status link", () => {
  const msg = composeSelected(TRACK, T, 7);
  assert.equal(msg.kind, "artist_selected");
  assert.ok(msg.subject.includes("T001"));
  assert.ok(msg.body.includes("slot 7"));
  assert.ok(msg.body.includes("/transmissions/001#static-bloom"));
  assert.ok(msg.body.includes("/track/track-x/aabbccdd"));
});

test("composeHeld explains rollover; composeResult covers all three verdicts", () => {
  const held = composeHeld(TRACK, T);
  assert.equal(held.kind, "artist_held");
  assert.ok(held.body.includes("rolls into the next submission window"));

  const crushed = composeResult(TRACK, T, {
    status: "crushed", rank: 1, crushes: 7, unique_listeners: 12, crush_rate: 0.583,
  });
  assert.ok(crushed.subject.includes("CRUSHED"));
  assert.ok(crushed.body.includes("#1"));

  const retired = composeResult(TRACK, T, {
    status: "retired", rank: 5, crushes: 2, unique_listeners: 11, crush_rate: 0.18,
  });
  assert.ok(retired.body.includes("retired"));

  const unjudged = composeResult(TRACK, T, {
    status: "unjudged", rank: null, crushes: 1, unique_listeners: 3, crush_rate: 0.33,
  });
  assert.ok(unjudged.body.includes("resubmit"));
});
