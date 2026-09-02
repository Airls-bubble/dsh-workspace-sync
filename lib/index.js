/**
 * dsh-workspace-sync — DeepSeek Harness plugin (host half).
 *
 * P2P workspace sync between paired machines (macOS ↔ Windows) over the LAN:
 *   - tool `sync_workspace` : run an explicit two-way sync (diff-first; on
 *     conflict, report the plan and require confirmation; keep-both policy)
 *   - tool `sync_status`    : device identity, server port, peers, last report
 *   - tool `sync_pair`      : export/import/list/forget/discover pairing
 *
 * Crash-safety charter (DESIGN.md §6): this plugin runs inside the DSH host
 * process. NO static import of any @deepseek-ai/* peer happens at module
 * scope — peers are lazy-loaded inside apply(); if unresolvable (e.g. the
 * ~/.dsh/profiles/node_modules peer-link directory is missing), the plugin
 * logs and goes dormant. Any other failure is caught the same way. This
 * plugin must NEVER take DSH boot down with it. It patches no core bundle
 * and only uses cross-platform Node APIs.
 *
 * Peer resolution note (verified on this machine): profiles provide
 * @deepseek-ai/* through the ~/.dsh/profiles/node_modules peer-link
 * directory. Dev installs via `pnpm link` realpath-escape that chain — add
 * node_modules/@deepseek-ai/dsh-tools → the dsh installation's copy in that
 * case (see README dev section).
 *
 * Row config (per profile cordis layer):
 *   { enabled?: boolean, workspaceRoot?: string, port?: number,
 *     deviceName?: string, autoStart?: boolean }
 * Machine-local state: ~/.dsh/storages/workspace-sync.json
 * Workspace state:     <workspaceRoot>/.sync/ (baseline, trash, last report)
 */
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSyncService } from "./sync-service.js";
import { registerTools } from "./tools.js";

const name = "dsh-workspace-sync";
const inject = ["tools"];

async function apply(ctx, config) {
  const instance = Math.random().toString(36).slice(2, 8);
  const say = (level, msg) => {
    const line = new Date().toISOString() + " [" + level + "] (" + instance + ") " + msg;
    try {
      // boot trace: survives wherever host logs go (headless suppresses stdout);
      // size-guarded so a long-lived web profile can't grow it unboundedly
      const tracePath = join(homedir(), ".dsh", "storages", "workspace-sync.boot.log");
      try {
        if (statSync(tracePath).size > 1024 * 1024) writeFileSync(tracePath, "");
      } catch {}
      appendFileSync(tracePath, line + "\n", "utf8");
    } catch {}
    try {
      const logger = ctx && ctx.logger ? ctx.logger(name) : null;
      if (logger && typeof logger[level] === "function") logger[level](msg);
      else console[level === "error" ? "error" : "log"]("[" + name + "] " + msg);
    } catch {
      console.log("[" + name + "] " + msg);
    }
  };
  const log = (msg) => say("info", msg);
  const warn = (msg) => say("warn", msg);

  let svc = null;
  let started = false;

  try {
    const tools = ctx && ctx.tools;
    if (!tools || typeof tools.register !== "function") {
      warn("tools 服务不可用 — 插件休眠（DSH 不受影响）。inject 是否被 profile 裁剪？");
      return;
    }

    // lazy peer load: the ONLY import of @deepseek-ai/*, never at module scope
    const toolsMod = await import("@deepseek-ai/dsh-tools").catch((e) => {
      warn("@deepseek-ai/dsh-tools 不可解析（缺 peer 链接目录？）— 插件休眠: " + String((e && e.message) || e).split("\n")[0]);
      return null;
    });
    const defineTool = toolsMod && toolsMod.defineTool;
    if (typeof defineTool !== "function") {
      warn("defineTool 不可用 — 插件休眠（DSH 不受影响）。");
      return;
    }

    svc = createSyncService({ rowConfig: config, log });

    if (svc.settings.enabled && svc.settings.autoStart) {
      await svc.start();
      started = true;
      say("info", "start() complete — server listening");
      // cordis contract (verified against lib): effect() evaluates the thunk
      // immediately; a returned FUNCTION becomes the teardown disposer; a
      // Promise resolving to a function works too. Objects are rejected with
      // "Invalid effect", and returning svc.stop() directly would call it.
      ctx.effect(() => Promise.resolve(() => {
        say("info", "teardown dispose → stopping server");
        return svc.stop();
      }), name + ": sync server + mDNS");
    } else {
      log("autoStart 关闭：不启动同步服务（工具仍可用 sync_status 查看）。");
    }

    registerTools(tools, svc, log, defineTool);
    log("ready — workspace root: " + svc.settings.workspaceRoot);

    // ---- optional web panel RPC (web profile only; headless has no webServer) ----
    const webServer = ctx.get ? ctx.get("webServer") : undefined;
    if (webServer && typeof webServer.register === "function") {
      const dispatch = async (method, args) => {
        const a = args && typeof args === "object" ? args : {};
        switch (method) {
          case "status": return svc.status();
          case "runSync": return svc.runSync({ peerId: a.peerId, seed: a.seed, confirmConflicts: a.confirmConflicts === true, background: a.background === true });
          case "pairExport": return svc.pairExport();
          case "pairImport": return svc.pairImport(String(a.code || ""));
          case "pairForget": return svc.pairForget(String(a.peerId || ""));
          case "discover": return { online: await svc.pairDiscover() };
          case "setWorkspace": return svc.setWorkspaceRoot(String(a.path || ""));
          case "listDir": return svc.listDir(String(a.path || ""));
          case "listRoots": return svc.listRoots();
          default: throw new Error("未知方法: " + method);
        }
      };
      const readJsonBody = (req) => new Promise((resolveBody, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (c) => (body += c));
        req.on("end", () => resolveBody(body));
        req.on("error", reject);
      });
      const disposeRoute = webServer.register({
        kind: "prefix",
        path: "/workspace-sync/api",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
            return;
          }
          try {
            const payload = JSON.parse(await readJsonBody(req));
            const result = await dispatch(payload.method, payload.args);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, result }));
          } catch (err) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
        },
      });
      ctx.effect(() => Promise.resolve(() => {
        say("info", "teardown dispose → unregister /workspace-sync/api");
        if (typeof disposeRoute === "function") return disposeRoute();
      }), name + ": /workspace-sync/api routes");
      log("panel RPC registered at /workspace-sync/api");
    }
  } catch (e) {
    warn("初始化失败，插件休眠（DSH 不受影响）: " + String((e && e.message) || e));
    // never orphan a listening socket: if we started before failing, shut down
    try {
      if (started && svc) await svc.stop();
    } catch {}
  }
}

export { name, inject, apply };
