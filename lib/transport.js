/**
 * transport.js — plaintext HTTP transfer between paired machines.
 *
 * Server = dumb executor: it scans (with its own baseline), receives bytes,
 * renames, trashes, and commits baselines. All decisions live on the
 * initiator; the peer never merges anything.
 *
 * Security posture (DESIGN.md §9): plaintext LAN transfer by explicit user
 * decision. The Bearer token is a door key, not encryption — every route
 * except /sync/ping rejects unauthenticated requests, so a stranger on the
 * network can ring the bell but cannot come in.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { access, constants, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { scanManifest, readBaseline, writeBaseline, scopeHash } from "./manifest.js";

const PLUGIN_VERSION = "0.1.0";
const JSON_LIMIT = 8 * 1024 * 1024; // manifests/baselines/ops bodies

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Contain a client-supplied relPath inside `root`; refuse traversal, absolute
 * paths, and anything under `.sync/` (plugin state is machine-local).
 * @returns {string} absolute path
 */
export function contain(root, relPath) {
  const raw = String(relPath || "");
  if (!raw || raw.length > 1024) throw new Error("bad path");
  const normalized = posix.normalize(raw.split(sep).join("/"));
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("path escapes workspace: " + raw);
  }
  if (normalized === ".sync" || normalized.startsWith(".sync/")) throw new Error(".sync is machine-local");
  if (normalized.split("/").some((part) => part === ".git" || part === "node_modules")) {
    throw new Error("refusing excluded dir: " + raw);
  }
  const abs = join(root, normalized);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error("path escapes workspace: " + raw);
  return abs;
}

/** Retry renames — Windows AV/indexer holds files with EPERM/EBUSY for seconds. */
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

function readBody(req, limit = JSON_LIMIT) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * @param {{root:string|(() => string), store:{deviceId,deviceName,token}, port?:number, log:Function}} opts
 *   root may be a getter — the panel can switch workspaces at runtime and
 *   every route then serves the CURRENT root (baselines are per-root, they
 *   live under <root>/.sync, so switching is naturally safe).
 * @returns {Promise<{port:number, close:Promise<void>}>} port = actual bound port
 */
export function createSyncServer(opts) {
  const { store, log } = opts;
  const getRoot = typeof opts.root === "function" ? opts.root : () => opts.root;
  const getExcludes = typeof opts.getExcludes === "function" ? opts.getExcludes : () => [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    const route = req.method + " " + url.pathname;
    const root = getRoot(); // fresh per request — runtime workspace switching
    try {
      // --- door bell: identity only, no workspace data ---
      if (route === "GET /sync/ping") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ds: "dsh-workspace-sync", v: PLUGIN_VERSION, id: store.deviceId, name: store.deviceName }));
        return;
      }

      // --- door key check for everything else ---
      const auth = req.headers.authorization || "";
      const expected = "Bearer " + store.token;
      if (!auth.startsWith("Bearer ") || !safeEqual(auth, expected)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "未配对设备拒绝访问" }));
        return;
      }

      if (route === "POST /sync/manifest") {
        const excludes = await getExcludes();
        const baseline = await readBaseline(root, fsp);
        const { manifest, skipped } = await scanManifest(root, baseline, excludes);
        log("manifest served: " + Object.keys(manifest.entries).length + " entries (scope " + scopeHash(excludes) + ")");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ manifest, skipped, scopeHash: scopeHash(excludes), scopeExcludes: excludes }));
        return;
      }

      if (route === "GET /sync/file") {
        const abs = contain(root, url.searchParams.get("p"));
        try {
          await access(abs, constants.R_OK);
        } catch (e) {
          if (e && e.code === "ENOENT") {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "no such file" }));
            return;
          }
          throw e;
        }
        const size = (await stat(abs)).size;
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size) });
        createReadStream(abs).pipe(res);
        return;
      }

      if (route === "PUT /sync/file") {
        const abs = contain(root, url.searchParams.get("p"));
        await mkdir(dirname(abs), { recursive: true });
        const tmp = abs + ".dsync-tmp-" + process.pid;
        await pipeline(req, createWriteStream(tmp));
        await renameRetry(tmp, abs);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (route === "POST /sync/rename") {
        const body = JSON.parse(await readBody(req));
        const from = contain(root, body.path);
        const to = contain(root, body.to);
        await mkdir(dirname(to), { recursive: true });
        await renameRetry(from, to);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (route === "POST /sync/trash") {
        const body = JSON.parse(await readBody(req));
        const runId = String(body.runId || "unknown").replace(/[^0-9A-Za-z-]/g, "").slice(0, 40) || "unknown";
        const moved = [];
        const failed = [];
        for (const relPath of Array.isArray(body.paths) ? body.paths : []) {
          try {
            const abs = contain(root, relPath);
            const dest = join(root, ".sync", "trash", runId, relPath.split(sep).join("/"));
            await mkdir(dirname(dest), { recursive: true });
            await renameRetry(abs, dest);
            moved.push(relPath);
          } catch (e) {
            failed.push({ path: relPath, error: String((e && e.message) || e) });
          }
        }
        log("trash: " + moved.length + " moved, " + failed.length + " failed");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: failed.length === 0, moved, failed }));
        return;
      }

      if (route === "POST /sync/baseline") {
        // peer rescans with ITS OWN baseline (unchanged files keep hashes) and commits;
        // out-of-scope entries drop out here, so the committed baseline converges to scope.
        // A seed run carries the initiator's scopeExcludes — 播种即立法: the peer adopts it.
        let body = {};
        try { body = JSON.parse(await readBody(req)) || {}; } catch {}
        if (Array.isArray(body.scopeExcludes) && typeof opts.adoptScope === "function") {
          opts.adoptScope(body.scopeExcludes);
        }
        const baseline = await readBaseline(root, fsp);
        const { manifest } = await scanManifest(root, baseline, await getExcludes());
        await writeBaseline(root, manifest, fsp);
        log("baseline committed: " + Object.keys(manifest.entries).length + " entries");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, entries: Object.keys(manifest.entries).length }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no route: " + route }));
    } catch (e) {
      log("route error (" + route + "): " + String((e && e.message) || e));
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  });

  const listenPort = Number(opts.port) > 0 && Number(opts.port) < 65536 ? Number(opts.port) : 0;
  return new Promise((resolveServer, rejectServer) => {
    server.once("error", (e) => rejectServer(e));
    server.listen(listenPort, "0.0.0.0", () => {
      const port = server.address().port;
      log("sync server listening on 0.0.0.0:" + port);
      resolveServer({ port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

// ---------------------------------------------------------------- client ---

function authHeaders(token) {
  return { authorization: "Bearer " + token };
}

export async function pingPeer(peer, timeoutMs = 4000) {
  const res = await fetch(peer.url + "/sync/ping", { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error("ping HTTP " + res.status);
  return res.json();
}

export async function getManifest(peer, timeoutMs = 300000) {
  const res = await fetch(peer.url + "/sync/manifest", { method: "POST", headers: authHeaders(peer.token), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error("manifest HTTP " + res.status + (res.status === 401 ? "（令牌不匹配，重新配对）" : ""));
  return res.json();
}

async function downloadToFile(peer, relPath, destAbs, attempts = 3) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(peer.url + "/sync/file?p=" + encodeURIComponent(relPath), { headers: authHeaders(peer.token) });
      if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
      await mkdir(dirname(destAbs), { recursive: true });
      const tmp = destAbs + ".dsync-tmp-" + process.pid;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      await renameRetry(tmp, destAbs);
      return;
    } catch (e) {
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 300 * Math.pow(2, i)));
        continue;
      }
      throw new Error("拉取 " + relPath + " 失败: " + String((e && e.message) || e));
    }
  }
}

async function uploadFile(peer, absSrc, relPath, attempts = 3) {
  for (let i = 0; ; i++) {
    try {
      const size = (await stat(absSrc)).size;
      const res = await fetch(peer.url + "/sync/file?p=" + encodeURIComponent(relPath), {
        method: "PUT",
        headers: { ...authHeaders(peer.token), "content-length": String(size) },
        body: Readable.toWeb(createReadStream(absSrc)),
        duplex: "half",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      await res.json();
      return;
    } catch (e) {
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 300 * Math.pow(2, i)));
        continue;
      }
      throw new Error("推送 " + relPath + " 失败: " + String((e && e.message) || e));
    }
  }
}

async function postJson(peer, route, payload, timeoutMs = 120000) {
  const res = await fetch(peer.url + route, {
    method: "POST",
    headers: { ...authHeaders(peer.token), "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(route + " HTTP " + res.status + " " + JSON.stringify(data).slice(0, 200));
  return data;
}

export {
  downloadToFile,
  uploadFile,
  postJson,
};
