/**
 * engine.test.js — pure three-way merge planner tests. No I/O.
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planSync, planForcedSeed, conflictName, diffAgainstBaseline, summarizePlan } from "../lib/engine.js";

const E = (size, mtimeMs, hash) => ({ size, mtimeMs, hash });
const man = (entries) => ({ v: 1, generatedAt: "t", entries });

test("one-side modify → push to remote", () => {
  const base = man({ "a.md": E(1, 100, "h0") });
  const local = man({ "a.md": E(2, 200, "h1") });
  const remote = man({ "a.md": E(1, 100, "h0") });
  const plan = planSync({ baseline: base, local, remote, conflictStamp: "X" });
  assert.equal(plan.kind, "merge");
  assert.deepEqual(plan.remoteOps, [{ op: "put", path: "a.md", from: "initiator" }]);
  assert.deepEqual(plan.localOps, []);
  assert.equal(plan.summary.push, 1);
});

test("one-side add → push; one-side delete → remote trash", () => {
  const base = man({ "old.txt": E(1, 100, "h0") });
  const local = man({ "new.bin": E(9, 9, "h9"), "old.txt": E(1, 100, "h0") });
  const remote = man({ "old.txt": E(1, 100, "h0") });
  const plan = planSync({ baseline: base, local, remote, conflictStamp: "X" });
  assert.deepEqual(plan.remoteOps, [
    { op: "put", path: "new.bin", from: "initiator" },
  ]);
  assert.equal(plan.summary.push, 1);

  const local2 = man({});
  const plan2 = planSync({ baseline: base, local: local2, remote, conflictStamp: "X" });
  assert.deepEqual(plan2.remoteOps, [{ op: "trash", path: "old.txt" }]);
  assert.equal(plan2.localOps.length, 0);
});

test("pull: remote changed, local same", () => {
  const base = man({ "r.md": E(1, 100, "h0") });
  const local = man({ "r.md": E(1, 100, "h0") });
  const remote = man({ "r.md": E(5, 500, "h5") });
  const plan = planSync({ baseline: base, local, remote, conflictStamp: "X" });
  assert.deepEqual(plan.localOps, [{ op: "put", path: "r.md", from: "peer" }]);
});

test("both changed identically → noop", () => {
  const base = man({ "s.md": E(1, 100, "h0") });
  const same = man({ "s.md": E(3, 300, "h3") });
  const plan = planSync({ baseline: base, local: same, remote: man({ "s.md": E(3, 999, "h3") }), conflictStamp: "X" });
  assert.equal(plan.kind, "merge");
  assert.equal(plan.localOps.length + plan.remoteOps.length, 0);
  assert.equal(plan.summary.noop, 1);
});

test("modify-modify conflict → keep-both, newer wins the path", () => {
  const base = man({ "note.md": E(1, 100, "h0") });
  const local = man({ "note.md": E(2, 200, "hLOCAL") });
  const remote = man({ "note.md": E(3, 300, "hREMOTE") }); // newer
  const plan = planSync({ baseline: base, local, remote, conflictStamp: "STAMP" });
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].winner, "remote");
  const cPath = conflictName("note.md", "STAMP");
  assert.equal(cPath, "note.conflict-STAMP.md");
  // local: rename loser away, then pull winner from peer
  assert.deepEqual(plan.localOps, [
    { op: "rename-to-conflict", path: "note.md", to: cPath },
    { op: "put", path: "note.md", from: "peer" },
  ]);
  // remote: receive loser bytes at conflict path
  assert.deepEqual(plan.remoteOps, [{ op: "put", path: cPath, from: "initiator" }]);
});

test("modify-modify conflict, mtime tie → local wins (deterministic)", () => {
  const base = man({ "t.md": E(1, 100, "h0") });
  const local = man({ "t.md": E(2, 300, "hL") });
  const remote = man({ "t.md": E(2, 300, "hR") });
  const plan = planSync({ baseline: base, local, remote, conflictStamp: "S" });
  assert.equal(plan.conflicts[0].winner, "local");
});

test("delete-vs-modify → modification wins, deleting side pulls it back", () => {
  const base = man({ "gone.md": E(1, 100, "h0") });
  const local = man({}); // deleted locally
  const remote = man({ "gone.md": E(4, 400, "h4") }); // modified remotely
  const plan = planSync({ baseline: base, local, remote, conflictStamp: "X" });
  assert.equal(plan.conflicts[0].type, "delete-vs-modify");
  assert.deepEqual(plan.localOps, [{ op: "put", path: "gone.md", from: "peer" }]);
  assert.deepEqual(plan.remoteOps, []);
});

test("both deleted → nothing to do", () => {
  const base = man({ "x.md": E(1, 100, "h0") });
  const plan = planSync({ baseline: base, local: man({}), remote: man({}), conflictStamp: "X" });
  assert.equal(plan.localOps.length + plan.remoteOps.length, 0);
});

test("no baseline: seed-push / seed-pull / refuse head-on collision", () => {
  const p1 = planSync({ baseline: null, local: man({ a: E(1, 1, "a") }), remote: man({}), conflictStamp: "X" });
  assert.equal(p1.kind, "seed-push");
  assert.equal(p1.remoteOps.length, 1);

  const p2 = planSync({ baseline: null, local: man({}), remote: man({ b: E(1, 1, "b") }), conflictStamp: "X" });
  assert.equal(p2.kind, "seed-pull");
  assert.equal(p2.localOps.length, 1);

  const p3 = planSync({
    baseline: null,
    local: man({ a: E(1, 1, "a") }),
    remote: man({ b: E(1, 1, "b") }),
    conflictStamp: "X",
  });
  assert.equal(p3.kind, "error");
  assert.match(p3.hint, /seed/);
});

test("forced seed: loser-side unique files are trashed, not overwritten silently", () => {
  const local = man({ "keep.md": E(1, 1, "h"), "local-only.txt": E(1, 1, "h") });
  const remote = man({ "keep.md": E(1, 1, "h"), "remote-only.txt": E(1, 1, "h") });
  const plan = planForcedSeed("push", local, remote);
  assert.equal(plan.kind, "seed-push");
  assert.deepEqual(plan.remoteOps, [
    { op: "put", path: "keep.md", from: "initiator" },
    { op: "put", path: "local-only.txt", from: "initiator" },
    { op: "trash", path: "remote-only.txt" },
  ]);
});

test("conflictName: nested path with extension", () => {
  assert.equal(conflictName("raw/private/日记.md", "20260903-120000"), "raw/private/日记.conflict-20260903-120000.md");
  assert.equal(conflictName("README", "S"), "README.conflict-S");
});

test("diffAgainstBaseline buckets add/modify/delete", () => {
  const base = { "m.md": E(1, 1, "h1"), "d.md": E(1, 1, "h1") };
  const cur = { "m.md": E(2, 2, "h2"), "a.md": E(1, 1, "h1") };
  const d = diffAgainstBaseline(base, cur);
  assert.deepEqual(d, { added: ["a.md"], modified: ["m.md"], deleted: ["d.md"] });
});

test("summarizePlan caps preview lists and keeps conflicts", () => {
  const plan = planSync({
    baseline: null,
    local: man(Object.fromEntries(Array.from({ length: 50 }, (_, i) => ["f" + i, E(1, 1, "h")]))),
    remote: man({}),
    conflictStamp: "X",
  });
  const s = summarizePlan(plan, 10);
  assert.equal(s.preview.remoteWrites.length, 10);
  assert.equal(s.localOps, 0);
});
