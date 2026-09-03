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
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { loadStore, saveStore, resolveSettings } from "./config.js";
import { scanManifest, readBaseline, writeBaseline, manifestStats, normalizeExcludes, scopeHash, pruneBaseline, GENERIC_USER_EXCLUDES, LEGACY_USER_EXCLUDES } from "./manifest.js";
import { planSync, planForcedSeed, summarizePlan } from "./engine.js";
import { createSyncServer, pingPeer, getManifest, downloadToFile, uploadFile, postJson } from "./transport.js";
import { startAdvertising, browsePeers } from "./discovery.js";
import { makePairCode, parsePairCode, makeShortCode, isShortCode } from "./pair.js";

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
  // runtime-active workspace root: UI selection wins over row config/cwd.
  // Kept in the machine store so it survives restarts; baselines are
  // per-root (<root>/.sync/baseline.json), so switching is naturally safe.
  let activeRoot = null;
  function currentRoot() {
    if (activeRoot) return activeRoot;
    const saved = store.activeWorkspaceRoot;
    activeRoot = (saved && existsSync(saved)) ? saved : settings.workspaceRoot;
    return activeRoot;
  }
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
    return createSyncServer({
      root: () => currentRoot(),
      store: { deviceId: store.deviceId, deviceName: settings.deviceName, token: store.token },
      port, log,
      getExcludes: () => effectiveExcludes(),
      getPairOffer: () => activePairOffer(),
      adoptScope: (excludes) => {
        const { excludes: clean } = normalizeExcludes(excludes);
        if (clean.length === 0) return;
        const root = currentRoot();
        if (!store.workspaceScopes) store.workspaceScopes = {};
        store.workspaceScopes[root] = { excludes: clean };
        saveStore(store, log, storePath);
        log("scope adopted from initiator: " + clean.join(", "));
      },
    });
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
    const peer = parsePairCode(String(code || "").trim());
    if (peer.id === store.deviceId) throw new Error("这是本机自己的配对码，不能导入给自己");
    const existing = store.peers[peer.id];
    store.peers[peer.id] = peer;
    saveStore(store, log, storePath);
    return { ok: true, peer, replaced: !!existing };
  }

  // --- pairing short codes (蓝牙式): the 6-digit code is a LAN pointer; the
  // full identity+token travels over the local claim route. Same channel the
  // long code used, so the threat model is unchanged. ---

  /** In-memory offer: shown on the panel, beaconed via mDNS TXT, claimable
   *  until expiry. */
  let pairOffer = null;
  const OFFER_TTL_MS = 10 * 60 * 1000;

  function startPairOffer() {
    const port = server ? server.port : settings.port;
    pairOffer = {
      short: makeShortCode(),
      long: makePairCode({ deviceId: store.deviceId, deviceName: settings.deviceName, port, token: store.token }),
      expiresAt: Date.now() + OFFER_TTL_MS,
    };
    if (advertise) advertise.setTxt({ pair: pairOffer.short }).catch(() => {});
    log("pairing offer started: " + pairOffer.short + " (10 min)");
    return { ok: true, code: pairOffer.short, expiresAt: new Date(pairOffer.expiresAt).toISOString() };
  }

  function cancelPairOffer() {
    if (!pairOffer) return { ok: true };
    pairOffer = null;
    if (advertise) advertise.setTxt({ pair: "" }).catch(() => {});
    log("pairing offer cancelled");
    return { ok: true };
  }

  function activePairOffer() {
    return pairOffer && Date.now() < pairOffer.expiresAt ? pairOffer : null;
  }

  /** Ask a specific peer for the payload behind a short code, then import. */
  async function claimFromPeer(url, code) {
    const r = await postJson({ url }, "/sync/pair-claim", { code: String(code || "").trim() });
    if (!r || !r.ok || !r.code) throw new Error((r && r.error) || "对端拒绝了这枚短码");
    return pairImport(r.code);
  }

  /** Browse the LAN for a machine whose beacon carries this short code. */
  async function pairByShortCode(code) {
    const found = await pairDiscover();
    const hit = (found.online || []).find((d) => d.pair === String(code).trim());
    if (!hit) throw new Error("局域网里没有正在等待这枚短码的设备（确认对端已生成短码、两机在同一网络）");
    return claimFromPeer(hit.url, code);
  }

  /** Import: six digits → short-code flow; otherwise full DSS1 code. */
  async function importPairCode(text) {
    const raw = String(text || "").trim();
    if (isShortCode(raw)) return pairByShortCode(raw);
    return pairImport(raw);
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
      workspaceRoot: currentRoot(),
      workspaceHistory: store.workspaceRoots || [],
      peers: pairList(),
      pairOffer: activePairOffer() ? { code: activePairOffer().short, expiresAt: new Date(activePairOffer().expiresAt).toISOString() } : null,
      syncing,
      lastReport,
    };
  }

  // ------------------------------------------------ workspace selection ---

  /** Switch the active workspace root (UI/驱动). Validates; remembers history. */
  async function setWorkspaceRoot(path) {
    const p = String(path || "").trim();
    if (!p) return { ok: false, error: "路径不能为空" };
    let resolved;
    try {
      resolved = fsp.realpath ? await fsp.realpath(p) : p;
    } catch {
      return { ok: false, error: "目录不存在: " + p };
    }
    const st = await fsp.stat(resolved).catch(() => null);
    if (!st || !st.isDirectory()) return { ok: false, error: "不是目录: " + resolved };
    if (resolved === join(resolved, ".sync") || resolved.split(/[\\/]/).pop() === ".sync") {
      return { ok: false, error: ".sync 是插件内部状态目录，不能当工作区" };
    }
    activeRoot = resolved;
    store.activeWorkspaceRoot = resolved;
    const hist = Array.isArray(store.workspaceRoots) ? store.workspaceRoots.filter((x) => x !== resolved) : [];
    store.workspaceRoots = [resolved, ...hist].slice(0, 8);
    saveStore(store, log, storePath);
    log("workspace root switched to " + resolved);
    return { ok: true, root: resolved, history: store.workspaceRoots, note: "基线随目录存放在各自 .sync/ 下，切换工作区不影响别的目录的同步状态。" };
  }

  /** Effective user excludes for the active root; first read persists the
   *  choice (legacy list for already-synced workspaces, generic otherwise). */
  async function effectiveExcludes() {
    const root = currentRoot();
    if (!store.workspaceScopes) store.workspaceScopes = {};
    if (!store.workspaceScopes[root]) {
      let seeded = GENERIC_USER_EXCLUDES;
      try {
        if (await readBaseline(root, fsp)) seeded = LEGACY_USER_EXCLUDES; // pre-0.4 synced workspace: keep scope identical
      } catch {}
      store.workspaceScopes[root] = { excludes: [...seeded] };
      saveStore(store, log, storePath);
      log("scope initialized for " + root + ": " + seeded.join(", "));
    }
    return store.workspaceScopes[root].excludes;
  }

  async function getScope() {
    const excludes = await effectiveExcludes();
    return { ok: true, excludes, hash: scopeHash(excludes), hard: [".sync/", "符号链接", ".DS_Store / desktop.ini / Thumbs.db"], note: "排除规则两边必须一致，不一致时同步会被拒绝。硬排除项不可配置。" };
  }

  function setScope(list) {
    const { excludes, invalid } = normalizeExcludes(list);
    if (invalid.length > 0) return { ok: false, error: "以下模式非法（不允许 .. 或绝对路径）: " + invalid.join(", "), invalid };
    const root = currentRoot();
    if (!store.workspaceScopes) store.workspaceScopes = {};
    store.workspaceScopes[root] = { excludes };
    saveStore(store, log, storePath);
    log("scope updated for " + root + ": " + excludes.join(", ") + " (hash " + scopeHash(excludes) + ")");
    return { ok: true, excludes, hash: scopeHash(excludes), note: "已保存。注意两边机器的规则要一致；已排除文件的本机与对端副本都不动，也不会传播删除。" };
  }

  /** List directories of `path` for the panel browser (dirs only, hidden skipped). */
  async function listDir(path) {
    const p = String(path || "").trim();
    if (!p) return listRoots();
    let target = p;
    if (!existsSync(target)) return { ok: false, error: "路径不存在: " + target };
    const st = await fsp.stat(target).catch(() => null);
    if (st && !st.isDirectory()) target = dirname(target);
    let dirents;
    try {
      dirents = await fsp.readdir(target, { withFileTypes: true });
    } catch (e) {
      return { ok: false, error: "无法读取目录 " + target + ": " + String((e && e.code) || e) };
    }
    const dirs = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    return { ok: true, path: target, parent: dirname(target) !== target ? dirname(target) : null, dirs, home: homedir() };
  }

  /** Entry points for the browser: drives on win32, filesystem root elsewhere. */
  async function listRoots() {
    if (platform() === "win32") {
      const drives = [];
      for (let code = 65; code <= 90; code++) {
        const drive = String.fromCharCode(code) + ":\\";
        if (existsSync(drive)) drives.push(drive);
      }
      return { ok: true, path: "", parent: null, dirs: drives, home: homedir(), label: "选择盘符" };
    }
    return { ...(await listDir("/")), home: homedir() };
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
      const root = currentRoot();
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

      const baseline0 = await readBaseline(root, fsp);
      // scope: user excludes for this root; first determination persists so
      // the fingerprint stays stable across restarts (migration: a workspace
      // that already has a baseline was synced under the pre-0.4 built-in
      // list — carry it over verbatim, upgrades never change scope).
      const excludes = await effectiveExcludes();
      const myHash = scopeHash(excludes);
      const baseline = pruneBaseline(baseline0, excludes);
      log("scanning local workspace…");
      const local = await scanManifest(root, baseline, excludes);
      log("local scan done: " + Object.keys(local.manifest.entries).length + " entries, fetching peer manifest…");
      const remote = await getManifest(peer);
      log("remote scan done: " + Object.keys(remote.manifest.entries).length + " entries");

      if (!seed && remote.scopeHash && remote.scopeHash !== myHash) {
        return {
          ok: false,
          status: "scope_mismatch",
          error: "两台机器的同步范围（排除规则）不一致，拒绝执行——范围不对称会被引擎误判成对端删除。请先在两边面板的「工作区」卡里把排除规则改成一致。",
          localExcludes: excludes,
          remoteExcludes: remote.scopeExcludes || [],
        };
      }

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
          const fresh = await scanManifest(root, baseline, excludes);
          await writeBaseline(root, fresh.manifest, fsp);
          await postJson(peer, "/sync/baseline", { scopeExcludes: excludes }); // 播种即立法：对端采纳发起方范围
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
      const fresh = await scanManifest(root, baseline, excludes);
      await writeBaseline(root, fresh.manifest, fsp);
      let peerBaseline = null;
      try {
        peerBaseline = await postJson(peer, "/sync/baseline", { scopeExcludes: excludes }); // 播种即立法
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
    setWorkspaceRoot,
    getScope,
    setScope,
    listDir,
    listRoots,
    pairExport,
    pairImport,
    pairList,
    pairForget,
    pairDiscover,
    startPairOffer,
    cancelPairOffer,
    claimFromPeer,
    importPairCode,
    runSync,
  };
}
