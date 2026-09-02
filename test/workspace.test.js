/**
 * workspace.test.js — runtime workspace selection (UI-driven root switching).
 * Real service + real dirs in a temp folder; no HTTP needed for these.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";

test("setWorkspaceRoot validates, switches, and remembers history", async () => {
  const base = await fsp.mkdtemp(join(os.tmpdir(), "wss-ws-"));
  const rootA = join(base, "alpha");
  const rootB = join(base, "beta");
  await fsp.mkdir(join(rootA, "sub"), { recursive: true });
  await fsp.mkdir(rootB, { recursive: true });

  const { createSyncService } = await import("../lib/sync-service.js");
  const log = () => {};
  const svc = createSyncService({
    rowConfig: { workspaceRoot: rootA },
    log,
    storePath: join(base, "store.json"),
  });

  // boot default = row config root
  assert.equal(svc.status().workspaceRoot, rootA);

  // reject: nonexistent path
  assert.equal((await svc.setWorkspaceRoot(join(base, "nope"))).ok, false);
  // reject: a file, not a directory
  await fsp.writeFile(join(base, "plain.txt"), "x");
  assert.equal((await svc.setWorkspaceRoot(join(base, "plain.txt"))).ok, false);
  // reject: empty
  assert.equal((await svc.setWorkspaceRoot("")).ok, false);

  // switch to B → status follows, history records both
  const res = await svc.setWorkspaceRoot(rootB);
  assert.equal(res.ok, true);
  assert.equal(svc.status().workspaceRoot, rootB);
  assert.deepEqual(svc.status().workspaceHistory[0], rootB);

  // persistence: a NEW service instance (same store file) boots on B
  const svc2 = createSyncService({
    rowConfig: { workspaceRoot: rootA },
    log,
    storePath: join(base, "store.json"),
  });
  assert.equal(svc2.status().workspaceRoot, rootB);

  // listDir navigation: roots → base → sees alpha/beta
  const atBase = await svc.listDir(base);
  assert.equal(atBase.ok, true);
  assert.ok(atBase.dirs.includes("alpha") && atBase.dirs.includes("beta"));
  // hidden dirs are skipped
  await fsp.mkdir(join(base, ".secret"), { recursive: true });
  const again = await svc.listDir(base);
  assert.ok(!again.dirs.includes(".secret"));
  // parent navigation ends at filesystem root (parent=null)
  const atFsRoot = await svc.listDir("/");
  assert.equal(atFsRoot.parent, null);
  // missing path → error object, not throw
  assert.equal((await svc.listDir(join(base, "ghost"))).ok, false);

  // cleanup
  await fsp.rm(base, { recursive: true, force: true });
});
