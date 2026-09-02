/**
 * render.test.js — real React SSR render of the web panel components.
 * Covers the open/close store contract: overlay renders nothing while
 * closed, the centered modal when open; the trigger reflects the state.
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

test("trigger + store-driven modal render through real react-dom/server", async () => {
  assert.equal(loaded.length, 1);
  const def = loaded[0];
  const exported = def.factory(() => react);
  assert.equal(exported.inject[0], "slots");
  assert.ok(exported.__test, "应暴露 __test 开关钩子");
  const { setOpen, getOpen } = exported.__test;

  const registrations = [];
  const ctx = {
    slots: {
      inject: (_name, fn) => fn(),
      register: (meta, render) => registrations.push({ meta, render }),
    },
  };
  exported.apply(ctx);
  assert.equal(registrations.length, 2);

  const trigger = registrations.find((r) => r.meta.name === "sidebar.footer.action");
  const overlay = registrations.find((r) => r.meta.name === "shell.overlay");

  // 关闭态：overlay 渲染为空，触发钮显示入口文案
  assert.equal(getOpen(), false);
  assert.equal(renderToString(overlay.render({})), "");
  const trigClosed = renderToString(trigger.render({ wide: true }));
  assert.match(trigClosed, /工作区同步/);

  // 打开态：store 翻转 → 居中弹窗渲染出全部内容，触发钮变「关闭面板」
  setOpen(true);
  const openHtml = renderToString(overlay.render({}));
  assert.match(openHtml, /wss-backdrop/);
  assert.match(openHtml, /wss-modal/);
  assert.match(openHtml, /工作区同步/);
  assert.match(openHtml, /立即同步/);
  assert.match(renderToString(trigger.render({ wide: true })), /关闭面板/);

  // 再关上：回到空
  setOpen(false);
  assert.equal(renderToString(overlay.render({})), "");
});
