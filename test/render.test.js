/**
 * render.test.js — real React SSR render of the settings-page entry.
 * The plugin registers one slot (settings.general.item, like the theme's
 * appearance row) and its content renders inline — no modal, no store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const react = require2("react");
const { renderToString } = require2("react-dom/server");

// stub the browser globals the client module touches at load time
const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (d) => loaded.push(d) } };
globalThis.document = {
  getElementById: () => ({ set textContent(_) {} }),
  createElement: () => ({ set textContent(_) {}, style: {} }),
  head: { appendChild: () => {} },
};

await import("../lib/client.js");

test("settings row renders the whole panel inline through react-dom/server", async () => {
  assert.equal(loaded.length, 1);
  const def = loaded[0];
  const exported = def.factory(() => react);
  assert.equal(exported.inject[0], "slots");
  assert.ok(exported.__test, "应暴露 __test 渲染钩子");

  const registrations = [];
  const injected = [];
  const ctx = {
    slots: {
      inject: (name, fn) => { injected.push(name); fn(); },
      register: (meta, render) => registrations.push({ meta, render }),
    },
  };
  exported.apply(ctx);

  // 唯一入口：settings.section（设置页左栏分区，与「通用设置」「模型」同级）
  assert.deepEqual(injected, ["settings.section"]);
  assert.equal(registrations.length, 1);
  const row = registrations[0];
  assert.equal(row.meta.name, "settings.section");
  assert.equal(row.meta.id, "workspace-sync");
  assert.equal(row.meta.order, 30);

  const html = renderToString(row.render({}));
  assert.match(html, /工作区同步/, "行标题");
  assert.match(html, /wss-sect/, "分区页布局类");
  assert.match(html, /立即同步/, "面板内容内联渲染");
  assert.ok(!html.includes("wss-backdrop") && !html.includes("wss-modal"), "弹窗时代应彻底翻篇");
});
