// Crush Radio — state machine + survival rule tests
// Run with: npm test (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveState,
  pickActiveTransmission,
  certifyResults,
  parseSetlist,
  wilsonLowerBound,
  SIGNAL_FLOOR,
} from "../workers/main/state.js";

const T = {
  id: "T001",
  submission_open_at: 1000,
  submission_close_at: 2000,
  setlist_publish_at: 3000,
  broadcast_start_at: 4000,
  broadcast_end_at: 5000,
  replay_close_at: 6000,
};

test("deriveState walks all six states in order", () => {
  assert.equal(deriveState(null, 500).state, "dark");
  assert.equal(deriveState(T, 500).state, "dark");
  assert.equal(deriveState(T, 500).next_transition_at_utc_ms, 1000);
  assert.equal(deriveState(T, 1000).state, "submissions_open");
  assert.equal(deriveState(T, 1999).state, "submissions_open");
  assert.equal(deriveState(T, 2000).state, "submissions_closed");
  assert.equal(deriveState(T, 3000).state, "setlist_published");
  assert.equal(deriveState(T, 4000).state, "live");
  assert.equal(deriveState(T, 4999).next_transition_at_utc_ms, 5000);
  assert.equal(deriveState(T, 5000).state, "results");
  assert.equal(deriveState(T, 6000).state, "dark");
  assert.equal(deriveState(T, 6000).next_transition_at_utc_ms, null);
});

test("pickActiveTransmission prefers the earliest unfinished cycle", () => {
  const t2 = { ...T, id: "T002", submission_open_at: 7000, replay_close_at: 12000 };
  const rows = [T, t2];
  assert.equal(pickActiveTransmission(rows, 1500).id, "T001");
  assert.equal(pickActiveTransmission(rows, 6500).id, "T002"); // T001 done → next governs (dark, counting down)
  assert.equal(pickActiveTransmission([T], 9999).id, "T001"); // everything done → latest, derives dark
  assert.equal(pickActiveTransmission([], 1), null);
});

test("parseSetlist tolerates missing and malformed JSON", () => {
  assert.deepEqual(parseSetlist(null), []);
  assert.deepEqual(parseSetlist({ setlist_json: null }), []);
  assert.deepEqual(parseSetlist({ setlist_json: "not json" }), []);
  assert.deepEqual(parseSetlist({ setlist_json: '{"a":1}' }), []);
  assert.equal(parseSetlist({ setlist_json: '[{"track_id":"x"}]' }).length, 1);
});

test("certifyResults: top third of eligible crushed, rest retired, floor failures unjudged", () => {
  const stats = [
    // 6 eligible tracks, crush rates 60%..10%
    ...[60, 50, 40, 30, 20, 10].map((rate, i) => ({
      track_id: `t${i + 1}`,
      position: i + 1,
      played: true,
      crushes: rate,
      unique_listeners: 100,
    })),
    // below minListeners → unjudged even with a perfect rate
    { track_id: "few", position: 7, played: true, crushes: 5, unique_listeners: 6 },
    // below minCrushes → unjudged
    { track_id: "quiet", position: 8, played: true, crushes: 2, unique_listeners: 50 },
    // never aired → unjudged
    { track_id: "skipped", position: 9, played: false, crushes: 0, unique_listeners: 0 },
  ];
  const out = certifyResults(stats, SIGNAL_FLOOR);
  const byId = Object.fromEntries(out.map((r) => [r.track_id, r]));

  // ceil(6 * 0.33) = 2 survive
  assert.equal(byId.t1.status, "crushed");
  assert.equal(byId.t1.rank, 1);
  assert.equal(byId.t2.status, "crushed");
  assert.equal(byId.t2.rank, 2);
  for (const id of ["t3", "t4", "t5", "t6"]) {
    assert.equal(byId[id].status, "retired");
  }
  assert.equal(byId.few.status, "unjudged");
  assert.equal(byId.quiet.status, "unjudged");
  assert.equal(byId.skipped.status, "unjudged");
  assert.equal(byId.skipped.rank, null);
  assert.equal(byId.t1.crush_rate, 0.6);
});

test("certifyResults: empty room → everything unjudged (owner escape valve applies)", () => {
  const out = certifyResults(
    [{ track_id: "a", position: 1, played: true, crushes: 0, unique_listeners: 0 }],
    SIGNAL_FLOOR
  );
  assert.equal(out[0].status, "unjudged");
  assert.equal(out[0].crush_rate, 0);
});

test("wilsonLowerBound: more evidence at the same rate scores higher", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(30, 100) > wilsonLowerBound(3, 10));
  assert.ok(wilsonLowerBound(40, 100) > wilsonLowerBound(4, 10));
  assert.ok(wilsonLowerBound(80, 100) > wilsonLowerBound(40, 100));
  const lb = wilsonLowerBound(40, 100);
  assert.ok(lb > 0.3 && lb < 0.4);
});

test("certifyResults: a loved big room outranks a same-rate small room", () => {
  const stats = [
    { track_id: "small", position: 1, played: true, crushes: 3, unique_listeners: 10 },
    { track_id: "big", position: 2, played: true, crushes: 30, unique_listeners: 100 },
    { track_id: "mid", position: 3, played: true, crushes: 5, unique_listeners: 40 },
  ];
  const out = certifyResults(stats, SIGNAL_FLOOR);
  const byId = Object.fromEntries(out.map((r) => [r.track_id, r]));
  // Same 30% rate — the 100-listener track carries far more evidence.
  assert.equal(byId.big.rank, 1);
  assert.equal(byId.big.status, "crushed"); // ceil(3 × 0.33) = 1 survivor
  assert.equal(byId.small.rank, 2);
  assert.equal(byId.small.status, "retired");
});

test("certifyResults: ties break by absolute crushes, then setlist position", () => {
  const stats = [
    { track_id: "a", position: 2, played: true, crushes: 30, unique_listeners: 100 },
    { track_id: "b", position: 1, played: true, crushes: 30, unique_listeners: 100 },
    { track_id: "c", position: 3, played: true, crushes: 15, unique_listeners: 50 },
  ];
  const out = certifyResults(stats, SIGNAL_FLOOR);
  const byId = Object.fromEntries(out.map((r) => [r.track_id, r]));
  // all tie at 30% — b wins rank 1 on position; ceil(3*0.33)=1 survives
  assert.equal(byId.b.rank, 1);
  assert.equal(byId.b.status, "crushed");
  assert.equal(byId.a.rank, 2);
  assert.equal(byId.a.status, "retired");
  assert.equal(byId.c.status, "retired");
});
