/**
 * pair.test.js — 6-digit pairing short codes: format, the claim route
 * (wrong code 404, right code yields the full DSS1 payload, brute-force
 * lockout), end-to-end claim → peer stored → sync works, and offer
 * lifecycle in status().
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSyncService } from "../lib/sync-service.js";
import { makeShortCode, isShortCode } from "../lib/pair.js";

const noopLog = () => {};

test("short codes: six digits, crypto-random", () => {
  for (let i = 0; i < 20; i++) {
    const c = makeShortCode();
    assert.ok(isShortCode(c), c + " 应为 6 位数字");
    assert.ok(c >= "100000" && c <= "999999");
  }
  assert.ok(!isShortCode("12345"));
  assert.ok(!isShortCode("1234567"));
  assert.ok(!isShortCode("12a456"));
  assert.ok(!isShortCode("DSS1.x"));
});

async function makeSide(t, tag) {
  const root = await mkdtemp(join(tmpdir(), "wss-pair-" + tag + "-"));
  const storePath = join(await mkdtemp(join(tmpdir(), "wss-pair-cfg-")), "store.json");
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  t.after(() => rm(storePath, { recursive: true, force: true }).catch(() => {}));
  const svc = createSyncService({ rowConfig: { workspaceRoot: root }, log: noopLog, storePath });
  await svc.start();
  t.after(() => svc.stop());
  return { svc, root };
}

test("claim route: wrong code 404 → right code imports peer → sync works", async (t) => {
  const A = await makeSide(t, "A");
  const B = await makeSide(t, "B");

  // no active offer → any code fails
  await assert.rejects(
    () => B.svc.claimFromPeer("http://127.0.0.1:" + A.svc.server.port, "123456"),
    /短码无效|拒绝/,
  );

  const offer = A.svc.startPairOffer();
  assert.ok(isShortCode(offer.code));
  // status() 应暴露进行中的 offer
  assert.equal(A.svc.status().pairOffer.code, offer.code);

  // 正确短码 → 对端入库
  const claimed = await B.svc.claimFromPeer("http://127.0.0.1:" + A.svc.server.port, offer.code);
  assert.equal(claimed.ok, true);
  const peers = Object.values(B.svc.store.peers);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, A.svc.store.deviceId);

  // 拿到令牌后，真实同步直接可用（短码只是指针，令牌已随 claim 送达）
  await writeFile(join(A.root, "hello.md"), "由短码配对后的第一次同步\n");
  const synced = await B.svc.runSync({ peerId: peers[0].id });
  assert.ok(synced.ok || synced.status === "started", JSON.stringify(synced));
  if (synced.status !== "started") {
    assert.equal(synced.report.kind, "seed-pull", "B 发起、B 为空 → 自动从 A 拉取播种");
    assert.equal(await readFile(join(B.root, "hello.md"), "utf8"), "由短码配对后的第一次同步\n");
  }

  // 作废后，原短码立即失效
  A.svc.cancelPairOffer();
  assert.equal(A.svc.status().pairOffer, null);
  await assert.rejects(
    () => B.svc.claimFromPeer("http://127.0.0.1:" + A.svc.server.port, offer.code),
    /短码无效|拒绝/,
  );
});

test("claim route: brute-force lockout after 5 wrong codes", async (t) => {
  const A = await makeSide(t, "L");
  A.svc.startPairOffer();
  const url = "http://127.0.0.1:" + A.svc.server.port;
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => A.svc.claimFromPeer(url, "00000" + (i % 10)), /短码无效/);
  }
  // 第 6 次即使拿对短码也被锁拒（同 IP）
  await assert.rejects(() => A.svc.claimFromPeer(url, A.svc.status().pairOffer.code), /频繁|无效|拒绝/);
});
