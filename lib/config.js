/**
 * config.js — machine-local configuration. NEVER synced.
 *
 * Two layers:
 *  - row config (from the cordis layer, per profile): {enabled, workspaceRoot,
 *    port, deviceName} — how THIS profile finds the workspace.
 *  - machine store (~/.dsh/storages/workspace-sync.json): identity + pairing
 *    secrets + peers. Created on first boot; the token is generated once and
 *    lives here forever (it IS the door key — back this file up with ~/.dsh).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const STORE_PATH = join(homedir(), ".dsh", "storages", "workspace-sync.json");
export const DEFAULT_PORT = 27891;

function newId() {
  return randomBytes(6).toString("hex");
}
function newToken() {
  return randomBytes(24).toString("hex");
}

/** Load (or lazily create) the machine store. `storePath` overridable for tests. */
export function loadStore(log, storePath = STORE_PATH) {
  try {
    if (existsSync(storePath)) {
      const parsed = JSON.parse(readFileSync(storePath, "utf8"));
      if (parsed && parsed.deviceId && parsed.token) {
        parsed.peers = parsed.peers || {};
        return parsed;
      }
    }
  } catch (e) {
    if (log) log("machine store unreadable, recreating: " + String((e && e.message) || e));
  }
  const fresh = {
    v: 1,
    deviceId: newId(),
    deviceName: hostname() || "dsh-machine",
    port: DEFAULT_PORT,
    token: newToken(),
    peers: {},
    createdAt: new Date().toISOString(),
  };
  saveStore(fresh, log, storePath);
  return fresh;
}

export function saveStore(store, log, storePath = STORE_PATH) {
  try {
    mkdirSync(join(storePath, ".."), { recursive: true });
    const tmp = storePath + ".tmp-" + process.pid;
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    renameSync(tmp, storePath);
  } catch (e) {
    if (log) log("FAILED to save machine store: " + String((e && e.message) || e));
  }
}

/**
 * Merge row config over the machine store into effective settings.
 * workspaceRoot precedence: row config → process cwd (the dsh launcher
 * contract: invoking directory is the workspace root).
 */
export function resolveSettings(rowConfig, store) {
  const rc = rowConfig && typeof rowConfig === "object" ? rowConfig : {};
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : d;
  };
  return {
    enabled: rc.enabled !== false,
    workspaceRoot: resolve(String(rc.workspaceRoot || process.cwd())),
    port: num(rc.port, store.port || DEFAULT_PORT),
    deviceName: String(rc.deviceName || store.deviceName || hostname() || "dsh-machine"),
    autoStart: rc.autoStart !== false,
  };
}

/** Best-guess LAN URL for pairing codes (first private IPv4, prefer 192.168/10.). */
export function bestLanUrl(port) {
  const nets = networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      candidates.push(net.address);
    }
  }
  candidates.sort((a, b) => {
    const score = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 2 : 3);
    return score(a) - score(b);
  });
  return "http://" + (candidates[0] || "127.0.0.1") + ":" + port;
}
