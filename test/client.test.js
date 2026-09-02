/**
 * client.test.js — wiring test for the web panel half, in Node with stubbed
 * window/document/react. Verifies: ModuleLoader registration id, slot
 * registration (sidebar + overlay), and that the components render element
 * trees without throwing.
 */
import test from "node:test";
import assert from "node:assert/strict";

// ---- stubs (must exist before importing lib/client.js) --------------------
const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => loaded.push(def),
  },
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ set textContent(v) {} }),
  head: { appendChild: () => {} },
};
let hookCalls = 0;
class StubComponent {
  constructor(props) { this.props = props; this.state = {}; }
  setState(p) { this.state = typeof p === "function" ? p(this.state) : p; }
  render() { return null; }
}
globalThis.__react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useSyncExternalStore: () => false,
  Component: StubComponent,
};
// lib/client.js does `require("react")` through the loader's shim — we
// execute the factory ourselves with that shim below.

const { execSync } = await import("node:child_process");
void execSync;

test("client half registers module, slots and renders components", async () => {
  await import("../lib/client.js");
  assert.equal(loaded.length, 1, "ModuleLoader.load 应被调用一次");
  const def = loaded[0];
  assert.equal(def.id, "dsh-workspace-sync");

  // run the factory with a require shim
  const exported = def.factory((name) => {
    assert.equal(name, "react");
    return globalThis.__react;
  });
  assert.equal(exported.inject.length, 1);
  assert.equal(exported.inject[0], "slots");

  // apply: must register exactly the two slots
  const registrations = [];
  const injected = [];
  const ctx = {
    slots: {
      inject: (slotName, registerFn) => {
        injected.push(slotName);
        registerFn();
      },
      register: (meta, render) => {
        registrations.push({ meta, render });
        return { meta, render };
      },
    },
  };
  exported.apply(ctx);
  assert.deepEqual(injected.sort(), ["shell.overlay", "sidebar.footer.action"]);
  assert.equal(registrations.length, 2);
  assert.ok(registrations.some((r) => r.meta.name === "sidebar.footer.action" && r.meta.id === "dsh-workspace-sync"));
  assert.ok(registrations.some((r) => r.meta.name === "shell.overlay"));

  // render both components: element trees, no throw
  for (const r of registrations) {
    const el = r.render({ wide: true });
    assert.ok(el && typeof el === "object" && "type" in el, r.meta.name + " 应渲染出元素树");
  }
});
