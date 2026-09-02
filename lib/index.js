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
 * process. apply() is wrapped end-to-end — any failure leaves the plugin
 * dormant with a logged warning; it must NEVER take DSH boot down with it.
 * It patches no core bundle and only uses cross-platform Node APIs.
 *
 * Row config (per profile cordis layer):
 *   { enabled?: boolean, workspaceRoot?: string, port?: number,
 *     deviceName?: string, autoStart?: boolean }
 * Machine-local state: ~/.dsh/storages/workspace-sync.json
 * Workspace state:     <workspaceRoot>/.sync/ (baseline, trash, last report)
 */
import { defineTool as _defineToolProof } from "@deepseek-ai/dsh-tools";
import { createSyncService } from "./sync-service.js";
import { registerTools } from "./tools.js";

void _defineToolProof; // imported here once so a missing dsh-tools fails loudly at load

const name = "dsh-workspace-sync";
const inject = ["tools"];

async function apply(ctx, config) {
  const say = (level, msg) => {
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

  try {
    const tools = ctx && ctx.tools;
    if (!tools || typeof tools.register !== "function") {
      warn("tools 服务不可用 — 插件休眠（DSH 不受影响）。inject 是否被 profile 裁剪？");
      return;
    }

    const svc = createSyncService({ rowConfig: config, log });

    if (svc.settings.enabled && svc.settings.autoStart) {
      await svc.start();
      ctx.effect(() => svc.stop(), name + ": sync server + mDNS");
    } else {
      log("autoStart 关闭：不启动同步服务（工具仍可用 sync_status 查看）。");
    }

    registerTools(tools, svc, log);
    log("ready — workspace root: " + svc.settings.workspaceRoot);
  } catch (e) {
    warn("初始化失败，插件休眠（DSH 不受影响）: " + String((e && e.message) || e));
  }
}

export { name, inject, apply };
