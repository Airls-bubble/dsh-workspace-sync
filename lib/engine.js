/**
 * engine.js — three-way merge planner. PURE LOGIC, no I/O.
 *
 * Inputs: baseline manifest (last successful sync), local manifest, remote
 * manifest. Output: an operation plan that converges both machines.
 *
 * Operation primitives (executor decides which side runs them):
 *   {op:"put",    path, from:"initiator"|"peer"}  write `path` with the named
 *                  side's current content (bytes flow through the initiator,
 *                  which mediates every transfer)
 *   {op:"rename-to-conflict", path, to}           rename the existing file to
 *                  a keep-both conflict name on the machine applying it
 *   {op:"trash",  path}                            move into that machine's
 *                  .sync/trash/<run>/ — NEVER a hard delete (DESIGN.md §3)
 *
 * Conflict policy (巨维 2026-09-02 裁示): keep-both. The newer file keeps the
 * original path; the older content lives on under `name.conflict-<stamp><ext>`
 * on BOTH machines. Nothing is ever silently overwritten, not one byte lost.
 * delete-vs-modify converges on the modification (nothing recoverable exists
 * on the deleting side; the change is preserved and loudly reported).
 */
import { posix } from "node:path";

/** Per-path state vs baseline: "same" | "changed" | "deleted" | null (unknown). */
function stateVs(baselineEntries, sideEntries, path) {
  const has = sideEntries[path];
  const had = baselineEntries[path];
  if (has && !had) return "changed";
  if (has && had) {
    return has.hash === had.hash && has.size === had.size ? "same" : "changed";
  }
  if (!has && had) return "deleted";
  return null;
}

/** diff one side against the baseline (for reports). */
export function diffAgainstBaseline(baselineEntries, sideEntries) {
  const added = [];
  const modified = [];
  const deleted = [];
  const paths = new Set([...Object.keys(baselineEntries), ...Object.keys(sideEntries)]);
  for (const path of paths) {
    const st = stateVs(baselineEntries, sideEntries, path);
    if (st === "changed") (baselineEntries[path] ? modified : added).push(path);
    else if (st === "deleted") deleted.push(path);
  }
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

/** `name.conflict-<stamp><ext>` next to the original. */
export function conflictName(path, stamp) {
  const dir = posix.dirname(path);
  const base = posix.basename(path);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const prefix = dir === "." ? "" : dir + "/";
  return prefix + stem + ".conflict-" + stamp + ext;
}

/**
 * Build the convergence plan.
 * @returns plan:
 *   { kind:"noop" | "seed-push" | "seed-pull" | "merge",
 *     localOps:[], remoteOps:[], conflicts:[], notes:[], summary:{...} }
 *   or { kind:"error", error, hint }
 */
export function planSync({ baseline, local, remote, conflictStamp }) {
  const baseEntries = baseline && baseline.entries ? baseline.entries : {};
  const localEntries = local.entries;
  const remoteEntries = remote.entries;

  const localOps = [];
  const remoteOps = [];
  const conflicts = [];
  const notes = [];

  // ---- no baseline yet: seeding ----
  if (!baseline) {
    const localCount = Object.keys(localEntries).length;
    const remoteCount = Object.keys(remoteEntries).length;
    if (localCount > 0 && remoteCount === 0) return seedPlan("push", localEntries, notes);
    if (localCount === 0 && remoteCount > 0) return seedPlan("pull", remoteEntries, notes);
    if (localCount === 0 && remoteCount === 0) {
      return { kind: "noop", localOps, remoteOps, conflicts, notes: ["两边工作区都是空的，没什么可同步。"], summary: {} };
    }
    return {
      kind: "error",
      error: "两边都有数据但从未同步过（无基线），拒绝盲目对撞。",
      hint: "确认哪边是真源后，用 seed:'push'（本机覆盖对端）或 seed:'pull'（对端覆盖本机）显式播种。",
    };
  }

  // ---- three-way merge ----
  const counts = { push: 0, pull: 0, trashLocal: 0, trashRemote: 0, conflict: 0, noop: 0 };
  const paths = new Set([...Object.keys(baseEntries), ...Object.keys(localEntries), ...Object.keys(remoteEntries)]);

  for (const path of [...paths].sort()) {
    const L = stateVs(baseEntries, localEntries, path);
    const R = stateVs(baseEntries, remoteEntries, path);
    if (L === null && R === null) continue;

    if (L === "same" && R === "same") continue;

    // one-sided changes — apply the changed side
    if (L === "changed" && R === "same") { remoteOps.push({ op: "put", path, from: "initiator" }); counts.push++; continue; }
    if (R === "changed" && L === "same") { localOps.push({ op: "put", path, from: "peer" }); counts.pull++; continue; }
    if (L === "deleted" && R === "same") { remoteOps.push({ op: "trash", path }); counts.trashRemote++; continue; }
    if (R === "deleted" && L === "same") { localOps.push({ op: "trash", path }); counts.trashLocal++; continue; }

    // one side changed, the other has never seen the path (added on one machine only)
    if (L === "changed" && R === null) { remoteOps.push({ op: "put", path, from: "initiator" }); counts.push++; continue; }
    if (R === "changed" && L === null) { localOps.push({ op: "put", path, from: "peer" }); counts.pull++; continue; }
    if ((L === "deleted" && R === null) || (R === "deleted" && L === null)) continue;

    // both changed identically — content already converged, baseline catches up on rescan
    if (L === "changed" && R === "changed" && localEntries[path].hash === remoteEntries[path].hash) {
      counts.noop++;
      continue;
    }

    // real conflicts
    if (L === "changed" && R === "changed") {
      const newerRemote = remoteEntries[path].mtimeMs > localEntries[path].mtimeMs;
      const winnerIsRemote = newerRemote; // exact mtime tie → local wins (deterministic)
      const cPath = conflictName(path, conflictStamp);
      if (winnerIsRemote) {
        localOps.push({ op: "rename-to-conflict", path, to: cPath });
        localOps.push({ op: "put", path, from: "peer" });
        remoteOps.push({ op: "put", path: cPath, from: "initiator" });
      } else {
        remoteOps.push({ op: "rename-to-conflict", path, to: cPath });
        remoteOps.push({ op: "put", path, from: "initiator" });
        localOps.push({ op: "put", path: cPath, from: "peer" });
      }
      conflicts.push({ path, type: "modify-vs-modify", winner: winnerIsRemote ? "remote" : "local", conflictCopy: cPath });
      counts.conflict++;
      continue;
    }
    if (L === "deleted" && R === "changed") {
      // remote modified what local deleted → modification wins (nothing lost: it still exists on remote)
      localOps.push({ op: "put", path, from: "peer" });
      conflicts.push({ path, type: "delete-vs-modify", winner: "remote", note: "本机删除被对端修改否决，保留对端修改版本" });
      counts.conflict++;
      continue;
    }
    if (R === "deleted" && L === "changed") {
      remoteOps.push({ op: "put", path, from: "initiator" });
      conflicts.push({ path, type: "delete-vs-modify", winner: "local", note: "对端删除被本机修改否决，修改版本推回对端" });
      counts.conflict++;
      continue;
    }
    if (L === "deleted" && R === "deleted") continue; // both gone — nothing to do
  }

  const summary = { ...counts };
  return { kind: "merge", localOps, remoteOps, conflicts, notes, summary };
}

function seedPlan(direction, entries, notes) {
  const localOps = [];
  const remoteOps = [];
  const paths = Object.keys(entries).sort();
  if (direction === "push") {
    for (const path of paths) remoteOps.push({ op: "put", path, from: "initiator" });
    notes.push("初始播种：本机 → 对端，单向全量 " + paths.length + " 个文件。");
    return { kind: "seed-push", localOps, remoteOps, conflicts: [], notes, summary: { seedPush: paths.length } };
  }
  for (const path of paths) localOps.push({ op: "put", path, from: "peer" });
  notes.push("初始播种：对端 → 本机，单向全量 " + paths.length + " 个文件。");
  return { kind: "seed-pull", localOps, remoteOps, conflicts: [], notes, summary: { seedPull: paths.length } };
}

/**
 * Explicit seed when no baseline exists and BOTH sides have data.
 * The chosen side becomes truth wholesale; the losing side's unique files
 * are TRASHED (recoverable), never silently overwritten.
 * @param {"push"|"pull"} direction — push: local is truth; pull: remote is truth.
 */
export function planForcedSeed(direction, local, remote) {
  const localIsTruth = direction === "push";
  const truthEntries = localIsTruth ? local.entries : remote.entries;
  const loserEntries = localIsTruth ? remote.entries : local.entries;
  const applyOps = []; // ops for the LOSING machine
  for (const path of Object.keys(truthEntries).sort()) applyOps.push({ op: "put", path, from: localIsTruth ? "initiator" : "peer" });
  for (const path of Object.keys(loserEntries).sort()) {
    if (!truthEntries[path]) applyOps.push({ op: "trash", path });
  }
  return {
    kind: direction === "push" ? "seed-push" : "seed-pull",
    localOps: localIsTruth ? [] : applyOps,
    remoteOps: localIsTruth ? applyOps : [],
    conflicts: [],
    notes: ["强制播种（两边都有数据）：以" + (localIsTruth ? "本机" : "对端") + "为真源；对端独有文件移入回收站而非直接覆盖。"],
    summary: { forcedSeed: Object.keys(truthEntries).length },
  };
}

/** Human-readable plan summary for chat reports (paths capped). */
export function summarizePlan(plan, cap = 30) {
  if (plan.kind === "error") return { kind: plan.kind, error: plan.error, hint: plan.hint };
  const list = (arr, n) => arr.slice(0, n);
  const byOp = (ops, op) => ops.filter((o) => o.op === op);
  return {
    kind: plan.kind,
    counts: plan.summary,
    conflicts: plan.conflicts,
    notes: plan.notes,
    localOps: plan.localOps.length,
    remoteOps: plan.remoteOps.length,
    preview: {
      localWrites: list(byOp(plan.localOps, "put").map((o) => o.path + " ←对端"), cap),
      localConflictRenames: list(byOp(plan.localOps, "rename-to-conflict").map((o) => o.path + " → " + o.to), cap),
      localTrashes: list(byOp(plan.localOps, "trash").map((o) => o.path), cap),
      remoteWrites: list(byOp(plan.remoteOps, "put").map((o) => o.path + " ←本机"), cap),
      remoteConflictRenames: list(byOp(plan.remoteOps, "rename-to-conflict").map((o) => o.path + " → " + o.to), cap),
      remoteTrashes: list(byOp(plan.remoteOps, "trash").map((o) => o.path), cap),
    },
  };
}
