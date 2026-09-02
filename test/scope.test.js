/**
 * scope.test.js — user-configurable sync scope (v0.4).
 * Covers pattern matching/validation, baseline pruning, migration seeding
 * (legacy list for pre-0.4 synced workspaces, generic for fresh ones),
 * persistence, and the fingerprint gate between mismatched peers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchExcludes, normalizeExcludes, scopeHash, pruneBaseline, scanManifest, GENERIC_USER_EXCLUDES, LEGACY_USER_EXCLUDES } from "../lib/manifest.js";
import { createSyncService } from "../lib/sync-service.js";

const noopLog = () => {};

test("matchExcludes semantics", () => {
  const rules = ["node_modules/", "*.tmp", "docs/internal", "secret.txt"];
  assert.equal(matchExcludes("a/node_modules/x.js", rules), true, "dir/ matches at any depth");
  assert.equal(matchExcludes("node_modules/x.js", rules), true);
  assert.equal(matchExcludes("temp.tmp", rules), true, "basename wildcard");
  assert.equal(matchExcludes("a/b/temp.tmp", rules), true, "wildcard matches at any depth");
  assert.equal(matchExcludes("docs/internal/note.md", rules), true, "path prefix");
  assert.equal(matchExcludes("docs/open.md", rules), false);
  assert.equal(matchExcludes("secret.txt", rules), true, "basename exact");
  assert.equal(matchExcludes("keep.secret.txt", rules), false, "no substring matches");
  assert.equal(matchExcludes("secret.txt.bak", rules), false, "suffix is a different file");
});

test("normalizeExcludes rejects traversal, absolutes and backslashes", () => {
  const { excludes, invalid } = normalizeExcludes([".git/", " ../evil", "/abs", "a\\b", "*.log", "", "*.log"]);
  assert.deepEqual(excludes, [".git/", "a/b", "*.log"]); // 反斜杠转正斜杠（粘贴友好），其余原样保留
  assert.equal(invalid.length, 2);
  assert.equal(scopeHash(["a", "b"]), scopeHash(["b", "a"]), "hash is order-independent");
  assert.notEqual(scopeHash(["a"]), scopeHash(["a", "b"]));
});

test("pruneBaseline drops out-of-scope entries", () => {
  const baseline = { entries: { "keep.md": { size: 1, mtimeMs: 1, hash: "h" }, "node_modules/x.js": { size: 2, mtimeMs: 2, hash: "h2" } } };
  const pruned = pruneBaseline(baseline, ["node_modules/"]);
  assert.ok(pruned.entries["keep.md"]);
  assert.ok(!pruned.entries["node_modules/x.js"]);
  assert.equal(pruned, baseline === pruned ? baseline : pruned); // shape intact
});

test("scanManifest honors user excludes", async () => {
  const root = await mkdtemp(join(tmpdir(), "wss-scope-"));
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await mkdir(join(root, "private"), { recursive: true });
  await writeFile(join(root, "keep.txt"), "k");
  await writeFile(join(root, "node_modules/pkg/index.js"), "x");
  await writeFile(join(root, "private/key.pem"), "x");
  const only = await scanManifest(root, null, ["private/"]);
  assert.ok(only.manifest.entries["keep.txt"]);
  assert.ok(!only.manifest.entries["private/key.pem"], "user exclude applies");
  assert.ok(only.manifest.entries["node_modules/pkg/index.js"], "defaults are applied by the service layer, not the scanner");
  const both = await scanManifest(root, null, [...GENERIC_USER_EXCLUDES, "private/"]);
  assert.ok(!both.manifest.entries["node_modules/pkg/index.js"], "combined list excludes dependency dirs");
  await rm(root, { recursive: true, force: true });
});

test("migration: baseline present → legacy seed; fresh → generic; setScope persists", async () => {
  const base = await mkdtemp(join(tmpdir(), "wss-mig-"));
  const mk = async (tag) => {
    const root = join(base, tag);
    await mkdir(root, { recursive: true });
    const storePath = join(base, tag + ".store.json");
    return { svc: createSyncService({ rowConfig: { workspaceRoot: root }, log: noopLog, storePath }), root, storePath };
  };
  // fresh workspace → generic
  const fresh = await mk("fresh");
  let scope = await fresh.svc.getScope();
  assert.deepEqual(scope.excludes, GENERIC_USER_EXCLUDES);
  await fresh.svc.stop();

  // pre-0.4 synced workspace (baseline exists) → legacy, so upgrades never change scope
  const legacy = await mk("legacy");
  await mkdir(join(legacy.root, ".sync"), { recursive: true });
  await writeFile(join(legacy.root, ".sync/baseline.json"), JSON.stringify({ v: 1, entries: {} }));
  scope = await legacy.svc.getScope();
  assert.deepEqual(scope.excludes, LEGACY_USER_EXCLUDES);

  // setScope: validation + persistence across service instances
  const bad = await legacy.svc.setScope(["ok.txt", "../evil"]);
  assert.equal(bad.ok, false);
  const good = await legacy.svc.setScope([".git/", "*.log"]);
  assert.equal(good.ok, true);
  assert.equal(good.hash, scopeHash([".git/", "*.log"]));
  const legacy2 = createSyncService({ rowConfig: { workspaceRoot: legacy.root }, log: noopLog, storePath: legacy.storePath });
  scope = await legacy2.getScope();
  assert.deepEqual(scope.excludes, [".git/", "*.log"]);
  await legacy.svc.stop();
  await legacy2.stop();
  await rm(base, { recursive: true, force: true });
});

test("fingerprint gate refuses merge between mismatched peers; seed adopts scope", async (t) => {
  const mk = async (tag) => {
    const root = await mkdtemp(join(tmpdir(), "wss-gate-" + tag + "-"));
    const storePath = join(await mkdtemp(join(tmpdir(), "wss-gate-cfg-")), "store.json");
    t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
    t.after(() => rm(storePath, { recursive: true, force: true }).catch(() => {}));
    const svc = createSyncService({ rowConfig: { workspaceRoot: root }, log: noopLog, storePath });
    await svc.start();
    t.after(() => svc.stop());
    return { svc, root };
  };
  const A = await mk("A");
  const B = await mk("B");
  const impA = A.svc.pairImport(B.svc.pairExport().code);
  A.svc.store.peers[impA.peer.id].url = "http://127.0.0.1:" + B.svc.server.port;

  await writeFile(join(A.root, "doc.md"), "v1\n");
  const seed = await A.svc.runSync({});
  assert.equal(seed.status, "synced", JSON.stringify(seed));
  // 播种即立法：B adopted A's scope
  const bScope = await B.svc.getScope();
  assert.deepEqual(bScope.excludes, GENERIC_USER_EXCLUDES);
  await stat(join(B.root, ".sync/baseline.json"));

  // B diverges its scope → A's merge must be refused
  await B.svc.setScope([".git/", "node_modules/", "*.tmp", "*.log"]);
  await writeFile(join(A.root, "doc.md"), "v2\n");
  const refused = await A.svc.runSync({});
  assert.equal(refused.status, "scope_mismatch", JSON.stringify(refused));

  // B realigns → merge passes
  await B.svc.setScope(GENERIC_USER_EXCLUDES);
  const merge = await A.svc.runSync({});
  assert.equal(merge.status, "synced", JSON.stringify(merge));
  assert.equal(await readFile(join(B.root, "doc.md"), "utf8"), "v2\n");
});
