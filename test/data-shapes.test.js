/**
 * data-shapes.test.js — SSR the Panel with fully-populated RPC data.
 * The field crash report: panel flashes on first open, then never renders
 * again while the trigger label keeps toggling — consistent with a throw in
 * the re-render after status arrives, swallowed by a host boundary. This
 * test feeds realistic status data straight into Panel so any such throw
 * reproduces here instead of in 巨维's browser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const react = require2("react");
const { renderToString } = require2("react-dom/server");

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (d) => loaded.push(d) } };
globalThis.document = {
  getElementById: () => ({ set textContent(_) {} }),
  createElement: () => ({ set textContent(_) {}, style: {} }),
  head: { appendChild: () => {} },
};

await import("../lib/client.js");

const RICH_STATUS = {
  enabled: true,
  device: { id: "a989c9988f0b", name: "juweideMac-mini.local" },
  server: { port: 27891, listening: true },
  workspaceRoot: "/Volumes/Data/AI",
  workspaceHistory: ["/Volumes/Data/AI", "/Volumes/Data/backup"],
  peers: [{ id: "win7f3a2", name: "DESKTOP-WIN", url: "http://192.168.1.20:27891" }],
  syncing: false,
  lastReport: { runId: "r1", kind: "noop", notes: ["ok"], durationMs: 12 },
};

test("panel renders every populated data shape without throwing", () => {
  const def = loaded[0];
  const exported = def.factory(() => react);
  const { SettingsSection, Shield } = exported.__test;

  const shapes = {
    "rich status": { __initialStatus: RICH_STATUS },
    "rich + needs_seed lastRun": {
      __initialStatus: { ...RICH_STATUS, lastReport: null },
    },
    "no server": { __initialStatus: { ...RICH_STATUS, server: { listening: false } } },
    "no history": { __initialStatus: { ...RICH_STATUS, workspaceHistory: [] } },
    "empty peers": { __initialStatus: { ...RICH_STATUS, peers: [] } },
    "minimal": { __initialStatus: { device: { id: "x", name: "n" }, server: {}, workspaceRoot: "/", peers: [] } },
  };

  for (const [name, props] of Object.entries(shapes)) {
    const html = renderToString(react.createElement(Shield, null, react.createElement(SettingsSection, props)));
    assert.match(html, /工作区同步/, name + " 应渲染出面板标题");
    assert.doesNotMatch(html, /面板渲染出错/, name + " 不应触发错误盾牌");
  }
});

test("shield maps render errors to visible fallback state", () => {
  const def = loaded[0];
  const exported = def.factory(() => react);
  const { Shield } = exported.__test;
  // renderToString does not exercise commit-phase boundaries, so assert the
  // boundary contract directly: getDerivedStateFromError must surface the
  // error for Shield.render to display (verified live in the field).
  const state = Shield.getDerivedStateFromError(new Error("boom-for-test"));
  assert.ok(state && state.err instanceof Error);
  assert.match(String(state.err), /boom-for-test/);
});
