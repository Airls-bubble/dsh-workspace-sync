/**
 * sync-service.js — the orchestrator: owns the machine store, the local sync
 * server, mDNS advertising, pairing, and the runSync pipeline.
 *
 * runSync is initiator-driven: THIS machine scans (baseline-assisted), asks
 * the peer to scan (peer uses its own baseline), plans with engine.js, then
 * mediates every byte: pulls what it needs, pushes what the peer needs,
 * trashes on both sides, and finally both sides re-scan with their old
 * baselines and commit new ones.
 */
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadStore, saveStore, resolveSettings } from "./config.js";
import { scanManifest, readBaseline, writeBaseline, manifestStats } from "./manifest.js";
import { planSync, planForcedSeed, summarizePlan } from "./engine.js";
import { createSyncServer, pingPeer, getManifest, downloadToFile, uploadFile, postJson } from "./transport.js";
import { startAdvertising, browsePeers } from "./discovery.js";
import { makePairCode, parsePairCode } from "./pair.js";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** fs.rename with Windows AV/indexer retry (mirrors transport.js server side). */
async function renameRetry(from, to, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = e && e.code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, i)));
        continue;
      }
      throw e;
    }
  }
}

export function createSyncService({ rowConfig, log, storePath }) {
  const store = loadStore(log, storePath);
  const settings = resolveSettings(rowConfig, store);
  let server = null;
  let advertise = null;
  let syncing = false;
  let lastReport = null;

  async function start() {
    if (server) return;
    // prefer the configured port; on collision fall back to ephemeral and warn
    try {
      server = await listenOn(settings.port);
    } catch (e) {
      log("port " + settings.port + " busy (" + String((e && e.code) || e) + "), falling back to ephemeral port — 配对码里的 URL 会失效，建议清出端口后重启");
      server = await listenOn(0);
    }
    advertise = await startAdvertising({ deviceName: settings.deviceName, port: server.port, deviceId: store.deviceId, log });
    log("workspace-sync ready: " + settings.deviceName + " (" + store.deviceId + ") root=" + settings.workspaceRoot);
  }

  function listenOn(port) {
    return createSyncServer({ root: settings.workspaceRoot, store: { deviceId: store.deviceId, deviceName: settings.deviceName, token: store.token }, port, log });
  }

  async function stop() {
    if (advertise) await advertise.stop();
    if (server) await server.close();
    advertise = null;
    server = null;
  }

  // ------------------------------------------------------------- pairing ---

  function pairExport() {
    return { device: { id: store.deviceId, name: settings.deviceName, port: server ? server.port : settings.port }, code: makePairCode({ deviceId: store.deviceId, deviceName: settings.deviceName, port: server ? server.port : settings.port, token: store.token }) };
  }

  function pairImport(code) {
    const peer = parsePairCode(code);
    if (peer.id === store.deviceId) throw new Error("这是本机自己的配对码，不能导入给自己");
    const existing = store.peers[peer.id];
    store.peers[peer.id] = peer;
    saveStore(store, log, storePath);
    return { ok: true, peer, replaced: !!existing };
  }

  function pairList() {
    return Object.values(store.peers);
  }

  function pairForget(peerId) {
    if (!store.peers[peerId]) return { ok: false, error: "没有这个对端: " + peerId };
    delete store.peers[peerId];
    saveStore(store, log, storePath);
    return { ok: true };
  }

  async function pairDiscover() {
    return browsePeers({ log });
  }

  // -------------------------------------------------------------- status ---

  function status() {
    return {
      enabled: settings.enabled,
      device: { id: store.deviceId, name: settings.deviceName },
      server: server ? { port: server.port, listening: true } : { listening: false },
      workspaceRoot: settings.workspaceRoot,
      peers: pairList(),
      syncing,
      lastReport,
    };
  }

  // ------------------------------------------------------------- runSync ---

  async function runSync({ peerId, seed, confirmConflicts, background } = {}) {
    if (syncing) return { ok: false, status: "busy", error: "已有一个同步在进行，稍候再试。" };
    if (!settings.enabled) return { ok: false, status: "disabled", error: "插件被 row config 禁用（enabled: false）。" };
    syncing = true;
    let backgroundStarted = false;
    const runId = stamp();
    const t0 = Date.now();
    try {
      const root = settings.workspaceRoot;
      const rootStat = await fsp.stat(root).catch(() => null);
      if (!rootStat || !rootStat.isDirectory()) {
        return { ok: false, status: "error", error: "工作区根不存在: " + root + "（用 row config workspaceRoot 指定）" };
      }

      const peers = pairList();
      const peer = peerId ? store.peers[peerId] : peers.length === 1 ? peers[0] : undefined;
      if (!peer) {
        return {
          ok: false,
          status: "no-peer",
          error: peers.length === 0 ? "还没有已配对的对端。先用 sync_pair action:'export' 拿配对码，在对端 import。" : "有多个对端，请用 peerId 指定: " + peers.map((p) => p.id + "(" + p.name + ")").join(", "),
          candidates: peers.length > 1 ? peers.map((p) => ({ id: p.id, name: p.name })) : undefined,
        };
      }

      const info = await pingPeer(peer).catch((e) => {
        throw new Error("对端不可达 " + peer.url + " — " + String((e && e.message) || e));
      });
      if (info.id !== peer.id) log("警告: 对端 id 变了 (" + peer.id + " → " + info.id + ")，仍按令牌继续");

      const baseline = await readBaseline(root, fsp);
      log("scanning local workspace…");
      const local = await scanManifest(root, baseline);
      log("local scan done: " + Object.keys(local.manifest.entries).length + " entries, fetching peer manifest…");
      const remote = await getManifest(peer);
      log("remote scan done: " + Object.keys(remote.manifest.entries).length + " entries");

      let plan;
      if (seed === "push" || seed === "pull") {
        if (baseline) {
          return { ok: false, status: "error", error: "本机已有基线（同步过），不再接受强制播种。如确要重种，删除 " + join(root, ".sync", "baseline.json") + " 后重试。" };
        }
        plan = planForcedSeed(seed, local.manifest, remote.manifest);
      } else {
        plan = planSync({ baseline, local: local.manifest, remote: remote.manifest, conflictStamp: runId });
        if (plan.kind === "error") {
          return { ok: false, status: "needs_seed", error: plan.error, hint: plan.hint, remoteStats: manifestStats(remote.manifest), localStats: manifestStats(local.manifest) };
        }
      }

      if (plan.kind === "noop") {
        if (!baseline) {
          const fresh = await scanManifest(root, baseline);
          await writeBaseline(root, fresh.manifest, fsp);
          await postJson(peer, "/sync/baseline", {});
        }
        const report = { runId, kind: "noop", notes: plan.notes, durationMs: Date.now() - t0 };
        lastReport = report;
        return { ok: true, status: "noop", report };
      }

      const conflicts = plan.conflicts || [];

      // nothing to apply at all → honest noop
      if (plan.kind === "merge" && conflicts.length === 0 && plan.localOps.length === 0 && plan.remoteOps.length === 0) {
        const report = { runId, kind: "noop", peer: { id: peer.id, name: peer.name }, notes: ["两边已经一致，无可同步。"], durationMs: Date.now() - t0 };
        lastReport = report;
        return { ok: true, status: "noop", report };
      }

      if (conflicts.length > 0 && !confirmConflicts) {
        return {
          ok: true,
          status: "needs_confirmation",
          message: "发现 " + conflicts.length + " 个冲突文件。确认前不动任何字节。核对下面的计划后，带 confirm_conflicts:true 重跑。",
          plan: summarizePlan(plan),
        };
      }

      // ---- apply + commit, extracted so it can run in the background ----
      const execute = async () => {
        try {
          const errors = [];
          const trashDir = join(root, ".sync", "trash", runId);
          let appliedLocal = 0;
          let appliedRemote = 0;
      for (const op of plan.localOps) {
        try {
          if (op.op === "put") {
            await downloadToFile(peer, op.path, join(root, op.path));
          } else if (op.op === "rename-to-conflict") {
            await fsp.mkdir(dirname(join(root, op.to)), { recursive: true });
            await renameRetry(join(root, op.path), join(root, op.to));
          } else if (op.op === "trash") {
            const dest = join(trashDir, op.path);
            await fsp.mkdir(dirname(dest), { recursive: true });
            await renameRetry(join(root, op.path), dest);
          }
          appliedLocal++;
        } catch (e) {
          errors.push({ side: "local", op, error: String((e && e.message) || e) });
        }
      }
      // ---- apply: remote ops (bytes always flow through the initiator) ----
      const remoteTrashPaths = [];
      for (const op of plan.remoteOps) {
        try {
          if (op.op === "put") {
            if (op.from !== "initiator") throw new Error("remote put 只接受 from:'initiator'，计划错误");
            await uploadFile(peer, join(root, op.path), op.path);
          } else if (op.op === "rename-to-conflict") {
            await postJson(peer, "/sync/rename", { path: op.path, to: op.to });
          } else if (op.op === "trash") {
            remoteTrashPaths.push(op.path);
          }
          appliedRemote++;
        } catch (e) {
          errors.push({ side: "remote", op, error: String((e && e.message) || e) });
        }
      }
      if (remoteTrashPaths.length > 0) {
        try {
          const result = await postJson(peer, "/sync/trash", { runId, paths: remoteTrashPaths });
          if (result.failed && result.failed.length > 0) {
            for (const f of result.failed) errors.push({ side: "remote", op: { op: "trash", path: f.path }, error: f.error });
          }
        } catch (e) {
          errors.push({ side: "remote", op: { op: "trash", paths: remoteTrashPaths }, error: String((e && e.message) || e) });
        }
      }

      // ---- commit baselines (each side rescans with its own old baseline) ----
      const fresh = await scanManifest(root, baseline);
      await writeBaseline(root, fresh.manifest, fsp);
      let peerBaseline = null;
      try {
        peerBaseline = await postJson(peer, "/sync/baseline", {});
      } catch (e) {
        errors.push({ side: "remote", op: { op: "baseline" }, error: "对端基线提交失败: " + String((e && e.message) || e) });
      }

      const report = {
        runId,
        peer: { id: peer.id, name: peer.name },
        kind: plan.kind,
        localStats: manifestStats(fresh.manifest),
        peerBaselineEntries: peerBaseline ? peerBaseline.entries : null,
        summary: plan.summary,
        conflicts,
        notes: plan.notes,
        applied: { local: appliedLocal, remote: appliedRemote },
        errors,
        skippedLocal: local.skipped,
        durationMs: Date.now() - t0,
      };
      try {
        await fsp.mkdir(join(root, ".sync"), { recursive: true });
        await fsp.writeFile(join(root, ".sync", "last-report.json"), JSON.stringify(report, null, 2), "utf8");
      } catch {}
      lastReport = { runId, kind: report.kind, durationMs: report.durationMs, summary: report.summary };
          return { ok: errors.length === 0, status: errors.length === 0 ? "synced" : "synced-with-errors", report };
        } finally {
          syncing = false;
        }
      };

      // background mode: fire-and-forget for the 4.6GB seed (a chat tool call
      // must not hang for half an hour); progress lives in status().syncing
      if (background) {
        backgroundStarted = true;
        execute().catch((e) => log("后台同步失败: " + String((e && (e.message || e)))));
        return { ok: true, status: "started", runId, peer: { id: peer.id, name: peer.name }, message: "同步已在后台开始。用 sync_status 查询：syncing=false 即结束，lastReport 为最终结果。" };
      }
      return await execute();
    } finally {
      if (!backgroundStarted) syncing = false;
    }
  }

  return {
    settings,
    store,
    get server() {
      return server;
    },
    start,
    stop,
    status,
    pairExport,
    pairImport,
    pairList,
    pairForget,
    pairDiscover,
    runSync,
  };
}
