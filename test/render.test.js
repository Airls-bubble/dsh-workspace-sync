/**
 * render.test.js — real React SSR render of the web panel components.
 * Catches hook misuse and JSX-less createElement bugs that the stubbed
 * wiring test cannot. Uses react-dom/server renderToString.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

test("panel and trigger render through real react-dom/server", async () => {
  assert.equal(loaded.length, 1);
  const def = loaded[0];
  const exported = def.factory(() => react);
  assert.equal(exported.inject[0], "slots");

  const registrations = [];
  const ctx = {
    slots: {
      inject: (_name, fn) => fn(),
      register: (meta, render) => registrations.push({ meta, render }),
    },
  };
  exported.apply(ctx);
  assert.equal(registrations.length, 2);

  for (const r of registrations) {
    const el = r.render({ wide: true });
    const html = renderToString(el);
    assert.ok(html.length > 40, r.meta.name + " 应渲染出实质 HTML");
  }
  // the trigger specifically renders the label when wide
  const trigger = registrations.find((r) => r.meta.name === "sidebar.footer.action");
  assert.match(renderToString(trigger.render({ wide: true })), /工作区同步/);
});
