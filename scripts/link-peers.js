#!/usr/bin/env node
/**
 * link-peers.js — one-time peer-link repair for machines where plugin peers
 * (@deepseek-ai/*) don't resolve (the ~/.dsh/profiles/node_modules
 * @deepseek-ai link directory is missing — plugin then boots dormant with
 * "dsh-tools 不可解析" in workspace-sync.boot.log).
 *
 * Creates symlinks (Windows: junctions — no admin rights needed) in
 * ~/.dsh/profiles/node_modules/@deepseek-ai/ pointing at every
 * @deepseek-ai package bundled with the global dsh installation.
 * NEVER overwrites existing entries.
 *
 * Run:  node scripts/link-peers.js
 */
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function globalNodeRoot() {
  for (const cmd of ["npm", "pnpm"]) {
    try {
      const out = execFileSync(cmd, ["root", "-g"], { encoding: "utf8" }).trim();
      if (out && existsSync(out)) return out;
    } catch {}
  }
  throw new Error("找不到全局 node_modules（npm root -g 失败）。请确认 Node/npm 安装完好。");
}

const srcDir = join(globalNodeRoot(), "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
if (!existsSync(srcDir)) throw new Error("dsh 安装里没有 " + srcDir + " — dsh 版本过旧或路径变更？");
const destBase = join(homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai");
mkdirSync(destBase, { recursive: true });

let created = 0;
let kept = 0;
for (const pkg of readdirSync(srcDir)) {
  const dest = join(destBase, pkg);
  if (existsSync(dest)) {
    kept++;
    continue;
  }
  // junction on win32: directory symlink WITHOUT admin rights
  symlinkSync(join(srcDir, pkg), dest, process.platform === "win32" ? "junction" : "dir");
  created++;
}
console.log("peer 链接完成：新建 " + created + " 个，已存在跳过 " + kept + " 个 → " + destBase);
if (created > 0) console.log("请重启 dsh 使插件恢复工作。");
