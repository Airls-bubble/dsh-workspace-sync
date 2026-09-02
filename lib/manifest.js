/**
 * manifest.js — workspace scan + content hashing + exclusion rules.
 *
 * A manifest is the single source of truth for "what is in the workspace
 * right now": `{ v, generatedAt, entries: { <relPath>: {size, mtimeMs, hash} } }`.
 * relPaths ALWAYS use forward slashes, on every platform, so manifests are
 * comparable across macOS and Windows.
 *
 * Baseline-assisted hashing: when a `baseline` manifest is supplied, a file
 * whose size AND mtime match the baseline entry reuses the recorded hash
 * instead of re-reading bytes. This is what makes re-scanning the 4.6GB
 * raw/ archive cheap: unchanged files cost one stat() each.
 *
 * Exclusion rules are the single source of truth for the whole plugin
 * (DESIGN.md §5). `.sync/` — this plugin's own state directory — is never
 * part of any manifest.
 */
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, stat, lstat } from "node:fs/promises";
import { join, sep, basename, posix } from "node:path";

/**
 * Scope model (v0.4):
 *  - HARD exclusions are not configurable: `.sync/` (this plugin's own state)
 *    and OS junk names. They never appear in the user-editable list.
 *  - USER excludes are glob-ish patterns stored per workspace root:
 *      `name/`   → exclude that directory at any depth
 *      `*.ext`   → exclude files whose basename matches the wildcard
 *      `a/b/c`   → exclude that exact path prefix
 *    Patterns are relative; `..` and absolute paths are rejected at save time.
 *  - scopeHash(excludes) is exchanged during sync; a mismatch refuses the run
 *    (asymmetric scope would look like mass peer-deletions otherwise).
 */

/** Directories excluded at ANY depth, not configurable. */
export const HARD_DIRS = new Set([".sync"]);
/** Files excluded at ANY depth (OS junk), not configurable. */
const HARD_NAMES = new Set([".DS_Store", "desktop.ini", "Thumbs.db"]);

/** Default user excludes for a NEW workspace (no baseline yet): universal only. */
export const GENERIC_USER_EXCLUDES = [".git/", "node_modules/", "*.tmp"];
/** What the pre-0.4 built-in list was — used to migrate existing synced workspaces
 *  verbatim so an upgrade never changes their scope. */
export const LEGACY_USER_EXCLUDES = [".git/", "node_modules/", ".wiki-state/", "*.tmp", "~*"];

/** Clean a user-supplied pattern list. Returns kept excludes + rejected entries. */
export function normalizeExcludes(list) {
  const seen = new Set();
  const excludes = [];
  const invalid = [];
  for (const raw of Array.isArray(list) ? list : String(list || "").split("\n")) {
    const p = String(raw).trim().replace(/^\.\//, "").replace(/\\/g, "/");
    if (!p) continue;
    if (p.includes("..") || p.startsWith("/") || p === "/") {
      invalid.push(raw);
      continue;
    }
    const key = p.replace(/\/+$/, "") + (p.endsWith("/") ? "/" : "");
    if (seen.has(key)) continue;
    seen.add(key);
    excludes.push(p.endsWith("/") ? p.replace(/\/+$/, "") + "/" : p);
  }
  return { excludes, invalid };
}

/** Does relPosix (posix, relative) fall under the user excludes? */
export function matchExcludes(relPosix, excludes) {
  const segments = relPosix.split("/");
  const base = segments[segments.length - 1];
  for (const raw of excludes || []) {
    const p = String(raw);
    if (p.endsWith("/")) {
      const dir = p.slice(0, -1);
      if (segments.includes(dir)) return true;
      continue;
    }
    if (p.includes("/")) {
      if (relPosix === p || relPosix.startsWith(p + "/")) return true;
      continue;
    }
    // basename wildcard: * matches anything except /
    if (p.includes("*")) {
      const re = new RegExp("^" + p.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
      if (re.test(base)) return true;
      continue;
    }
    if (base === p) return true;
  }
  return false;
}

/** sha256 fingerprint (short) of a normalized exclude list. */
export function scopeHash(excludes) {
  const canon = JSON.stringify([...(excludes || [])].sort());
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}

/** Drop baseline entries that fell out of scope, so rule changes never
 *  propagate deletions for files the user just excluded. */
export function pruneBaseline(baseline, excludes) {
  if (!baseline || !baseline.entries) return baseline;
  const entries = {};
  let changed = false;
  for (const key in baseline.entries) {
    if (matchExcludes(key, excludes)) {
      changed = true;
      continue;
    }
    entries[key] = baseline.entries[key];
  }
  return changed ? { ...baseline, entries } : baseline;
}

/** @param {string} relPosix path relative to the workspace root */
export function isExcluded(relPosix, excludes = []) {
  const base = posix.basename(relPosix);
  if (HARD_NAMES.has(base)) return true;
  if (matchExcludes(relPosix, excludes)) return true;
  return false;
}

function hashFile(absPath) {
  return new Promise((resolveHash, reject) => {
    const h = createHash("sha256");
    const stream = createReadStream(absPath, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => h.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(h.digest("hex")));
  });
}

/**
 * Walk `root` and build the manifest.
 * @param {string} root absolute workspace root
 * @param {{entries?: Record<string, {size:number,mtimeMs:number,hash:string}>}|null} baseline
 *   previous manifest — unchanged files reuse its hashes (mtime+size match).
 * @returns {Promise<{manifest: {v:number, generatedAt:string, entries:Record<string,{size:number,mtimeMs:number,hash:string}>},
 *                     skipped: Array<{path:string, reason:string}>}>}
 */
export async function scanManifest(root, baseline = null, excludes = []) {
  const entries = Object.create(null);
  const skipped = [];
  const baseEntries = baseline && baseline.entries ? baseline.entries : null;

  async function walk(relDir) {
    let dirents;
    try {
      dirents = await readdir(relDir ? join(root, relDir) : root, { withFileTypes: true });
    } catch (e) {
      skipped.push({ path: relDir, reason: "readdir failed: " + (e && e.code ? e.code : String(e)) });
      return;
    }
    for (const dirent of dirents) {
      const relPosix = relDir ? relDir + "/" + dirent.name : dirent.name;
      if (dirent.isDirectory()) {
        if (HARD_DIRS.has(dirent.name)) continue;
        if (matchExcludes(relPosix + "/", excludes)) continue;
        await walk(relPosix);
        continue;
      }
      if (dirent.isSymbolicLink()) {
        skipped.push({ path: relPosix, reason: "symlink (never synced)" });
        continue;
      }
      if (!dirent.isFile()) {
        skipped.push({ path: relPosix, reason: "not a regular file" });
        continue;
      }
      if (isExcluded(relPosix, excludes)) continue;
      let st;
      try {
        st = await stat(join(root, relPosix));
      } catch (e) {
        skipped.push({ path: relPosix, reason: "stat failed: " + (e && e.code ? e.code : String(e)) });
        continue;
      }
      const prev = baseEntries ? baseEntries[relPosix] : undefined;
      if (prev && prev.size === st.size && Math.abs(prev.mtimeMs - st.mtimeMs) < 2) {
        entries[relPosix] = { size: st.size, mtimeMs: st.mtimeMs, hash: prev.hash };
        continue;
      }
      try {
        entries[relPosix] = { size: st.size, mtimeMs: st.mtimeMs, hash: await hashFile(join(root, relPosix)) };
      } catch (e) {
        skipped.push({ path: relPosix, reason: "hash failed: " + (e && e.code ? e.code : String(e)) });
      }
    }
  }

  await walk("");
  return { manifest: { v: 1, generatedAt: new Date().toISOString(), entries }, skipped };
}

/** Read `.sync/baseline.json` under the workspace root, or null. */
export async function readBaseline(root, fsp) {
  try {
    const raw = await fsp.readFile(join(root, ".sync", "baseline.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && parsed.entries ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist `.sync/baseline.json` atomically. */
export async function writeBaseline(root, manifest, fsp) {
  const dir = join(root, ".sync");
  await fsp.mkdir(dir, { recursive: true });
  const final = join(dir, "baseline.json");
  const tmp = join(dir, "baseline.json.tmp-" + process.pid);
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 1), "utf8");
  await fsp.rename(tmp, final);
}

/** Count summary for reports. */
export function manifestStats(manifest) {
  const entries = manifest && manifest.entries ? manifest.entries : {};
  let files = 0;
  let bytes = 0;
  for (const key in entries) {
    files += 1;
    bytes += entries[key].size || 0;
  }
  return { files, bytes };
}

export { basename, sep };
