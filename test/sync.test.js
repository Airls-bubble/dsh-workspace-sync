/**
 * sync.test.js — end-to-end loopback: two real sync services, two real
 * workspaces, real HTTP between them on 127.0.0.1. Covers seeding, merge,
 * deletion-to-trash, conflict keep-both, token gate, path containment.
 * Run: node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSyncService } from "../lib/sync-service.js";

const noopLog = () => {};

async function makeSide(t) {
  const root = await mkdtemp(join(tmpdir(), "dsync-ws-"));
  const storePath = join(await mkdtemp(join(tmpdir(), "dsync-cfg-")), "store.json");
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  t.after(() => rm(storePath, { recursive: true, force: true }).catch(() => {}));
  const svc = createSyncService({ rowConfig: { workspaceRoot: root }, log: noopLog, storePath });
  await svc.start();
  t.after(() => svc.stop());
  return { svc, root };
}

/** point a service's peer record at the other side's 127.0.0.1 URL (hermetic). */
function wirePeer(fromSvc, toSvc, toId) {
  const peer = fromSvc.store.peers[toId];
  peer.url = "http://127.0.0.1:" + toSvc.server.port;
}

test("full lifecycle: seed → merge → delete-to-trash → conflict keep-both → noop", async (t) => {
  const A = await makeSide(t);
  const B = await makeSide(t);

  // pair (real code exchange, then hermetic URLs)
  const codeA = A.svc.pairExport().code;
  const codeB = B.svc.pairExport().code;
  const impA = A.svc.pairImport(codeB);
  const impB = B.svc.pairImport(codeA);
  assert.equal(impA.ok, true);
  wirePeer(A.svc, B.svc, impA.peer.id);
  wirePeer(B.svc, A.svc, impB.peer.id);

  // --- workspace A: nested dirs, binary bytes, junk that must NOT sync ---
  await mkdir(join(A.root, "alias/memory"), { recursive: true });
  await mkdir(join(A.root, "raw/private"), { recursive: true });
  await mkdir(join(A.root, ".git"), { recursive: true });
  await writeFile(join(A.root, "AGENTS.md"), "# 工作区\n");
  await writeFile(join(A.root, "alias/MEMORY.md"), "记忆 v1\n");
  await writeFile(join(A.root, "alias/memory/2026-09-02.md"), "日记\n");
  await writeFile(join(A.root, "raw/private/秘密.txt"), "私货\n");
  await writeFile(join(A.root, "raw/blob.bin"), Buffer.from([0, 1, 2, 250, 251]));
  await writeFile(join(A.root, ".git/HEAD"), "ref: should-not-sync\n");
  await writeFile(join(A.root, ".DS_Store"), "junk\n");
  await writeFile(join(A.root, "temp.tmp"), "junk\n");

  // --- seed push A → B (no baseline anywhere) ---
  const seed = await A.svc.runSync({});
  assert.equal(seed.status, "synced", JSON.stringify(seed));
  assert.equal(seed.report.kind, "seed-push");
  assert.equal(await readFile(join(B.root, "alias/MEMORY.md"), "utf8"), "记忆 v1\n");
  assert.equal(await readFile(join(B.root, "raw/private/秘密.txt"), "utf8"), "私货\n");
  assert.deepEqual(Buffer.from(await readFile(join(B.root, "raw/blob.bin"))), Buffer.from([0, 1, 2, 250, 251]));
  await assert.rejects(readFile(join(B.root, ".git/HEAD")));
  await assert.rejects(readFile(join(B.root, ".DS_Store")));
  await assert.rejects(readFile(join(B.root, "temp.tmp")));
  // baselines exist on both sides
  await stat(join(A.root, ".sync/baseline.json"));
  await stat(join(B.root, ".sync/baseline.json"));

  // --- round 2: B modifies, A adds, A deletes → merge ---
  await writeFile(join(B.root, "alias/MEMORY.md"), "记忆 v2（B 端改的）\n");
  await mkdir(join(A.root, "wiki"), { recursive: true });
  await writeFile(join(A.root, "wiki/index.md"), "索引\n");
  await rm(join(A.root, "alias/memory/2026-09-02.md"));

  const merge = await A.svc.runSync({});
  assert.equal(merge.status, "synced", JSON.stringify(merge));
  assert.equal(merge.report.kind, "merge");
  // pull: B's edit reached A
  assert.equal(await readFile(join(A.root, "alias/MEMORY.md"), "utf8"), "记忆 v2（B 端改的）\n");
  assert.equal(await readFile(join(B.root, "alias/MEMORY.md"), "utf8"), "记忆 v2（B 端改的）\n");
  // push: A's new file reached B
  assert.equal(await readFile(join(B.root, "wiki/index.md"), "utf8"), "索引\n");
  // delete: B moved the deleted file into ITS trash (trash > rm)
  await assert.rejects(readFile(join(B.root, "alias/memory/2026-09-02.md")));
  const trashEntries = await readdirRecursive(join(B.root, ".sync/trash"));
  assert.ok(trashEntries.some((p) => p.endsWith("2026-09-02.md")), "删除的文件应在对端回收站: " + JSON.stringify(trashEntries));

  // --- round 3: conflict (both edit MEMORY.md differently) ---
  await writeFile(join(A.root, "alias/MEMORY.md"), "A 端版本\n");
  await writeFile(join(B.root, "alias/MEMORY.md"), "B 端版本\n");
  // make B's version newer → B wins the path, A's content keeps a conflict copy
  const future = new Date(Date.now() + 60_000);
  await utimes(join(B.root, "alias/MEMORY.md"), future, future);

  const staged = await A.svc.runSync({});
  assert.equal(staged.status, "needs_confirmation", JSON.stringify(staged));
  assert.equal(staged.plan.conflicts.length, 1);
  // nothing was touched by the staged run
  assert.equal(await readFile(join(A.root, "alias/MEMORY.md"), "utf8"), "A 端版本\n");

  const resolved = await A.svc.runSync({ confirmConflicts: true });
  assert.ok(resolved.status === "synced" || resolved.status === "synced-with-errors", JSON.stringify(resolved));
  // both sides: winner (B) at path, loser (A) under conflict name
  assert.equal(await readFile(join(A.root, "alias/MEMORY.md"), "utf8"), "B 端版本\n");
  assert.equal(await readFile(join(B.root, "alias/MEMORY.md"), "utf8"), "B 端版本\n");
  const conflictOnA = await readFile(join(A.root, "alias/MEMORY.conflict-" + resolved.report.runId + ".md"), "utf8");
  const conflictOnB = await readFile(join(B.root, "alias/MEMORY.conflict-" + resolved.report.runId + ".md"), "utf8");
  assert.equal(conflictOnA, "A 端版本\n");
  assert.equal(conflictOnB, "A 端版本\n");

  // --- round 4: no changes → noop ---
  const noop = await A.svc.runSync({});
  assert.equal(noop.status, "noop", JSON.stringify(noop));
});

test("token gate: wrong bearer is refused on every data route", async (t) => {
  const A = await makeSide(t);
  const B = await makeSide(t);
  const base = "http://127.0.0.1:" + B.svc.server.port;
  const wrong = { authorization: "Bearer deadbeef" };

  const ping = await fetch(base + "/sync/ping");
  assert.equal(ping.status, 200); // door bell is public, only identity
  const pingBody = await ping.json();
  assert.equal(pingBody.ds, "dsh-workspace-sync");

  for (const [method, route, init] of [
    ["POST", "/sync/manifest", {}],
    ["GET", "/sync/file?p=AGENTS.md", {}],
    ["PUT", "/sync/file?p=evil.txt", { body: "x" }],
    ["POST", "/sync/trash", { body: "{}" }],
    ["POST", "/sync/baseline", { body: "{}" }],
  ]) {
    const res = await fetch(base + route, { method, headers: { ...wrong, "content-type": "application/json" }, ...init });
    assert.equal(res.status, 401, method + " " + route + " 必须拒绝无令牌请求");
  }
});

test("path containment: traversal and .sync are refused", async (t) => {
  const B = await makeSide(t);
  const base = "http://127.0.0.1:" + B.svc.server.port;
  const codeB = B.svc.pairExport().code;
  // import against self is refused; parse the code manually for the token
  const payload = JSON.parse(Buffer.from(codeB.replace("DSS1.", ""), "base64url").toString("utf8"));
  const headers = { authorization: "Bearer " + payload.token };

  for (const p of ["../outside.txt", "a/../../escape", ".sync/baseline.json", "/abs/path", "x/.git/config"]) {
    const res = await fetch(base + "/sync/file?p=" + encodeURIComponent(p), { headers });
    assert.equal(res.status, 400, "应拒绝: " + p + " (got " + res.status + ")");
  }
  // a legit deep path 404s quietly rather than 400
  const ok404 = await fetch(base + "/sync/file?p=" + encodeURIComponent("no/such/file.txt"), { headers });
  assert.equal(ok404.status, 404);
});

import { readdir } from "node:fs/promises";
async function readdirRecursive(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        out.push(p);
        await walk(p);
      } else out.push(p);
    }
  }
  await walk(dir);
  return out;
}

test("background mode: returns 'started' immediately, completes on its own", async (t) => {
  const A = await makeSide(t);
  const B = await makeSide(t);
  const impA = A.svc.pairImport(B.svc.pairExport().code);
  const impB = B.svc.pairImport(A.svc.pairExport().code);
  wirePeer(A.svc, B.svc, impA.peer.id);
  wirePeer(B.svc, A.svc, impB.peer.id);

  await writeFile(join(A.root, "bg.txt"), "后台播种\n");
  const t0 = Date.now();
  const r = await A.svc.runSync({ background: true });
  const returnedIn = Date.now() - t0;
  assert.equal(r.status, "started", JSON.stringify(r));
  assert.ok(returnedIn < 3000, "后台模式必须立刻返回，实际 " + returnedIn + "ms");

  // poll until the background run drains
  for (let i = 0; i < 200; i++) {
    const s = A.svc.status();
    if (!s.syncing && s.lastReport) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const s = A.svc.status();
  assert.equal(s.syncing, false);
  assert.ok(s.lastReport, "后台完成后应有 lastReport");
  assert.equal(await readFile(join(B.root, "bg.txt"), "utf8"), "后台播种\n");

  // busy-guard: a second sync while one runs is refused (foreground path)
  await writeFile(join(A.root, "bg2.txt"), "x\n");
  const p1 = A.svc.runSync({});
  const busy = await A.svc.runSync({});
  assert.equal(busy.status, "busy");
  await p1;
});
