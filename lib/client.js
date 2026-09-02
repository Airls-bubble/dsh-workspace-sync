/**
 * dsh-workspace-sync — client half (web panel).
 *
 * Handwritten, build-free: the shape mirrors @dsh-market/plugin's client
 * half — window.__ModuleLoader__.load({id, factory}) exporting Cordis-style
 * {inject, apply}; the factory receives a require("react") shim provided by
 * the host's module loader. Two slots:
 *   - sidebar.footer.action → 「工作区同步」entry button
 *   - shell.overlay         → status/peers/pairing/sync panel
 * All data flows through POST /workspace-sync/api (host half, JSON RPC).
 */
window.__ModuleLoader__.load({
	id: "dsh-workspace-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const El = react.createElement;
		const h = react.useState;
		const f = react.useEffect;

		// ---------------------------------------------------------------- rpc --

		async function api(method, args) {
			const res = await fetch("/workspace-sync/api", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ method, args: args ?? {} }),
			});
			const data = await res.json();
			if (!data.ok) throw new Error(data.error ?? "RPC failed");
			return data.result;
		}

		// -------------------------------------------------------------- style --

		const CSS = `
.wss-wrap{display:flex;flex-direction:column;min-height:0;height:100%;color:var(--dsw-alias-label-primary,#252525);font-size:13px}
.wss-head{display:flex;align-items:center;gap:10px;padding:14px 16px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#eef0f2);flex:none}
.wss-head svg{width:22px;height:22px;color:#4d6bfe}
.wss-title{font-size:15px;font-weight:600}
.wss-sub{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary,#8a919f)}
.wss-body{flex:1;min-height:0;overflow-y:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:12px}
.wss-card{border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);border-radius:11px;padding:13px 14px;background:var(--dsw-alias-surface-primary,#fff)}
.wss-card h3{margin:0 0 8px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.wss-kv{display:flex;gap:8px;margin:3px 0;font-size:12.5px;line-height:1.5}
.wss-k{color:var(--dsw-alias-label-secondary,#8a919f);flex:none;width:88px}
.wss-v{word-break:break-all}
.wss-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
.wss-input{flex:1;min-width:180px;background:var(--wss-bg,#1b1b22);color:inherit;border:1px solid var(--wss-border,#3a3a45);border-radius:6px;padding:4px 8px;font:inherit}
.wss-check{display:flex;align-items:center;gap:4px;margin-left:auto;font-size:12px;opacity:.9;cursor:pointer}
.wss-browser{margin-top:8px;border:1px solid var(--wss-border,#3a3a45);border-radius:8px;padding:8px;max-height:240px;overflow:auto}
.wss-dirlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px;margin-top:6px}
.wss-dirlist .wss-btn{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;justify-content:flex-start}
.wss-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-strong,#d4d7dc);background:var(--dsw-alias-surface-primary,#fff);color:inherit;border-radius:8px;padding:5px 12px;font-size:12.5px;font-weight:500;font-family:inherit}
.wss-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}
.wss-btn:disabled{opacity:.5;cursor:not-allowed}
.wss-btn.primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
.wss-btn.primary:hover{background:#2e4bd8}
.wss-btn.danger{color:#b91c1c;border-color:#f5c6c6}
.wss-btn.danger:hover{background:#fdeaea}
.wss-code{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-strong,#d4d7dc);border-radius:8px;padding:8px 10px;font:12px ui-monospace,Menlo,monospace;background:var(--dsw-alias-surface-secondary,#f6f8fb);color:inherit;resize:vertical}
.wss-pre{margin:8px 0 0;padding:9px 11px;background:var(--dsw-alias-surface-secondary,#f6f8fb);border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);border-radius:8px;font:11.5px ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow-y:auto}
.wss-msg{font-size:12px;color:#15803d;min-height:16px}
.wss-msg.err{color:#b91c1c}
.wss-peer{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-subtle,#eef0f2);font-size:12.5px}
.wss-peer:last-child{border-bottom:none}
.wss-peer .name{font-weight:600}
.wss-peer .id{color:var(--dsw-alias-label-secondary,#8a919f);font-family:ui-monospace,Menlo,monospace;font-size:11px}
.wss-badge{font-size:11px;padding:1px 8px;border-radius:9px;background:#e8f6ee;color:#15803d}
.wss-badge.off{background:#f3f4f6;color:#8a919f}
.wss-note{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a919f);line-height:1.6;margin:6px 0 0}
`;

		function injectStyle() {
			if (document.getElementById("wss-style")) return;
			const tag = document.createElement("style");
			tag.id = "wss-style";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// -------------------------------------------------------------- icons --

		const SyncIcon = (props) =>
			El("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", width: props.size ?? 16, height: props.size ?? 16 },
				El("path", { d: "M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4" }),
				El("path", { d: "M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4" }),
				El("polyline", { points: "21 3 21 7 17 7" }),
				El("polyline", { points: "3 21 3 17 7 17" }));

		// ----------------------------------------------------------- components --

		function Trigger(props) {
			return El("button", {
				className: "wss-trigger-btn",
				onClick: () => setOpen(true),
				title: "工作区同步",
				"aria-label": "工作区同步",
				style: { all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", width: props.wide ? "100%" : "auto", padding: "6px 12px", boxSizing: "border-box", color: "inherit", fontSize: "13px" },
			}, El("span", { style: { display: "inline-flex" } }, El(SyncIcon, { size: 16 })),
				props.wide ? El("span", null, "工作区同步") : null);
		}

		function Kv(props) {
			return El("div", { className: "wss-kv" }, El("span", { className: "wss-k" }, props.k), El("span", { className: "wss-v" }, props.v));
		}

		function Panel(props) {
			const [status, setStatus] = h(null);
			const [busy, setBusy] = h("");
			const [msg, setMsg] = h({ ok: true, text: "" });
			const [pairCode, setPairCode] = h("");
			const [importText, setImportText] = h("");
			const [found, setFound] = h(null);
			const [lastRun, setLastRun] = h(null);
			const [showConfirm, setShowConfirm] = h(false);
			const [browser, setBrowser] = h(null); // {path,parent,dirs,home,label}
			const [pathInput, setPathInput] = h("");
			const [bgRun, setBgRun] = h(false);

			const refresh = async () => {
				try { setStatus(await api("status")); } catch (e) { setMsg({ ok: false, text: String(e.message || e) }); }
			};
			f(() => { injectStyle(); refresh(); }, []);

			const act = (label, fn) => async () => {
				setBusy(label); setMsg({ ok: true, text: "" });
				try { await fn(); } catch (e) { setMsg({ ok: false, text: String(e.message || e) }); }
				setBusy("");
			};

			const doSync = (confirmConflicts) => act(confirmConflicts ? "确认同步" : "同步", async () => {
				const r = await api("runSync", { confirmConflicts: !!confirmConflicts, background: bgRun });
				setLastRun(r);
				if (r.status === "started") {
					setMsg({ ok: true, text: "同步已在后台开始（大文件播种也不会卡住面板），稍后自动刷新状态。" });
					setTimeout(refresh, 5000);
					setTimeout(refresh, 15000);
				} else if (r.status === "needs_confirmation") {
					setMsg({ ok: true, text: "发现冲突，核对计划后点「确认执行（保双）」。" });
					setShowConfirm(true);
				} else if (r.ok) {
					setMsg({ ok: true, text: { seeded: "播种完成", synced: "同步完成", "synced-with-errors": "同步完成（有报错，见报告）", noop: "两边已一致，无需同步", "needs_seed": "需要显式播种（见下方报告）" }[r.status] || r.status });
				} else {
					setMsg({ ok: false, text: r.error || r.status });
				}
			})();

			const doSeed = (dir) => act("播种" + dir, async () => {
				const r = await api("runSync", { seed: dir, background: bgRun });
				setLastRun(r);
				if (r.status === "started") {
					setMsg({ ok: true, text: "播种已在后台开始，稍后自动刷新状态。" });
					setTimeout(refresh, 5000);
					setTimeout(refresh, 15000);
				} else if (r.ok) {
					setMsg({ ok: true, text: "播种完成。" });
					await refresh();
				} else setMsg({ ok: false, text: r.error || r.status });
			});

			return El("div", { className: "wss-wrap" },
				El("div", { className: "wss-head" },
					El(SyncIcon, { size: 22 }),
					El("span", { className: "wss-title" }, "工作区同步"),
					El("span", { className: "wss-sub" }, "Mac ↔ Win P2P"),
					El("button", { className: "wss-btn", onClick: props.onClose, style: { marginLeft: "8px" } }, "关闭")),
				El("div", { className: "wss-body" },
					// 本机
					El("div", { className: "wss-card" },
						El("h3", null, "本机"),
						status ? [
							El(Kv, { key: "n", k: "设备", v: status.device.name + "（" + status.device.id + "）" }),
							El(Kv, { key: "s", k: "同步服务", v: El("span", null, status.server && status.server.listening
								? [El("span", { key: "b", className: "wss-badge" }, "运行中 · 端口 " + status.server.port)]
								: El("span", { className: "wss-badge off" }, "未运行")) }),
						] : El("div", null, "读取中…")),
					// 工作区
					El("div", { className: "wss-card" },
						El("h3", null, "工作区"),
						status ? [
							El(Kv, { key: "r", k: "当前", v: status.workspaceRoot }),
							status.workspaceHistory && status.workspaceHistory.length > 1 ? El("div", { className: "wss-row", key: "hist" },
								status.workspaceHistory.map((r) => El("button", {
									key: r, className: "wss-btn" + (r === status.workspaceRoot ? " primary" : ""),
									disabled: busy !== "" || r === status.workspaceRoot,
									onClick: act("sel", async () => {
										const res = await api("setWorkspace", { path: r });
										if (res.ok) { await refresh(); setMsg({ ok: true, text: "工作区已切换：" + res.root }); }
										else setMsg({ ok: false, text: res.error });
									}),
								}, r.split(/[\\/]/).pop() || r))) : null,
							El("div", { className: "wss-row", key: "ops" },
								El("button", {
									className: "wss-btn", disabled: busy !== "",
									onClick: act("browse", async () => {
										if (browser) { setBrowser(null); return; }
										const listing = await api("listRoots");
										setBrowser(listing); setPathInput(listing.path || "");
									}),
								}, browser ? "收起浏览" : "选择目录…"),
								browser ? El("button", {
									className: "wss-btn primary", disabled: busy !== "" || !pathInput.trim(),
									onClick: act("setw", async () => {
										const res = await api("setWorkspace", { path: pathInput.trim() });
										if (res.ok) { setBrowser(null); await refresh(); setMsg({ ok: true, text: "工作区已设为：" + res.root }); }
										else setMsg({ ok: false, text: res.error });
									}),
								}, "设为工作区") : null),
							browser ? El("div", { className: "wss-browser", key: "br" },
								El("div", { className: "wss-row" },
									El("input", {
										className: "wss-input", value: pathInput, placeholder: "输入绝对路径，如 " + (browser.path === "" || browser.path.includes("\\") ? "D:\\AI" : "/Volumes/Data/AI"),
										onChange: (e) => setPathInput(e.target.value),
									}),
									El("button", {
										className: "wss-btn", disabled: busy !== "" || !pathInput.trim(),
										onClick: act("go", async () => {
											const listing = await api("listDir", { path: pathInput.trim() });
											if (listing.ok) setBrowser(listing); else setMsg({ ok: false, text: listing.error });
										}),
									}, "前往")),
								El("div", { className: "wss-row" },
									browser.parent !== null && browser.parent !== undefined ? El("button", {
										className: "wss-btn", disabled: busy !== "",
										onClick: act("up", async () => { const listing = await api("listDir", { path: browser.parent }); if (listing.ok) { setBrowser(listing); setPathInput(listing.path); } }),
									}, "上一级") : null,
									browser.home ? El("button", {
										className: "wss-btn", disabled: busy !== "",
										onClick: act("home", async () => { const listing = await api("listDir", { path: browser.home }); if (listing.ok) { setBrowser(listing); setPathInput(listing.path); } }),
									}, "主目录") : null),
								browser.label ? El("p", { className: "wss-note" }, browser.label) : null,
								browser.dirs.length === 0 ? El("p", { className: "wss-note" }, "（没有子目录）") : El("div", { className: "wss-dirlist" },
									browser.dirs.map((name) => {
										const sep = browser.path === "" || browser.path.includes("\\") ? "\\" : "/";
										const next = browser.path === "" ? name : browser.path.replace(/[\\/]+$/, "") + sep + name;
										return El("button", {
											key: name, className: "wss-btn", disabled: busy !== "",
											onClick: act("cd", async () => { const listing = await api("listDir", { path: next }); if (listing.ok) { setBrowser(listing); setPathInput(listing.path); } else setMsg({ ok: false, text: listing.error }); }),
										}, "📁 " + name);
									}))) : null,
							El("p", { className: "wss-note", key: "note" }, "两台机器各选各的根目录（如 Mac 选 /Volumes/Data/AI，Win 选 D:\\AI）；基线随目录存在各自 .sync/ 下，切换互不影响。"),
						] : null),
					// 对端
					El("div", { className: "wss-card" },
						El("h3", null, "已配对对端"),
						status && status.peers.length > 0
							? status.peers.map((p) => El("div", { className: "wss-peer", key: p.id },
								El("span", { className: "name" }, p.name),
								El("span", { className: "id" }, p.id),
								El("span", { className: "id" }, p.url),
								El("button", {
									className: "wss-btn danger", style: { marginLeft: "auto" },
									disabled: busy !== "",
									onClick: act("forget", async () => { await api("pairForget", { peerId: p.id }); await refresh(); setMsg({ ok: true, text: "已删除对端 " + p.name }); }),
								}, "删除")))
							: El("p", { className: "wss-note" }, "还没有对端。用下方「生成配对码」与另一台机器交换。"),
						El("div", { className: "wss-row" },
							El("button", { className: "wss-btn", disabled: busy !== "", onClick: act("export", async () => { const r = await api("pairExport"); setPairCode(r.code); setMsg({ ok: true, text: "配对码已生成，复制到另一台机器导入。" }); }) }, "生成配对码"),
							El("button", { className: "wss-btn", disabled: busy !== "", onClick: act("discover", async () => { setFound(await api("discover")); }) }, "发现局域网设备"))),
					// 配对码区
					(pairCode || importText !== "" || found) ? El("div", { className: "wss-card" },
						El("h3", null, "配对"),
						pairCode ? [
							El("textarea", { key: "c", className: "wss-code", rows: 3, readOnly: true, value: pairCode, onFocus: (e) => e.target.select() }),
							El("div", { className: "wss-row", key: "cb" },
								El("button", { className: "wss-btn primary", onClick: () => { navigator.clipboard.writeText(pairCode).then(() => setMsg({ ok: true, text: "已复制" })); } }, "复制配对码"),
								El("button", { className: "wss-btn", onClick: () => setPairCode("") }, "收起")),
						] : null,
						El("div", { style: { marginTop: "10px" } },
							El("textarea", { className: "wss-code", rows: 2, placeholder: "把对方机器的配对码粘贴到这里…", value: importText, onChange: (e) => setImportText(e.target.value) }),
							El("div", { className: "wss-row" },
								El("button", {
									className: "wss-btn primary", disabled: busy !== "" || !importText.trim(),
									onClick: act("import", async () => {
										const r = await api("pairImport", { code: importText.trim() });
										setImportText(""); await refresh();
										setMsg({ ok: true, text: "已配对：" + r.peer.name + "（" + r.peer.url + "）" });
									}),
								}, "导入配对码"))),
						found ? El("div", { style: { marginTop: "10px" } },
							El("p", { className: "wss-note" }, "局域网在线：", found.online.length === 0 ? "（无）" : null),
							found.online.map((d) => El("div", { className: "wss-peer", key: d.id }, El("span", { className: "name" }, d.name), El("span", { className: "id" }, d.url)))) : null) : null,
					// 同步
					El("div", { className: "wss-card" },
						El("h3", null, "同步"),
						El("div", { className: "wss-row" },
							El("button", { className: "wss-btn primary", disabled: busy !== "", onClick: () => doSync(false) }, busy === "同步" ? "同步中…" : "立即同步"),
							showConfirm ? El("button", { className: "wss-btn primary", disabled: busy !== "", onClick: () => doSync(true) }, "确认执行（保双）") : null,
							El("label", { className: "wss-check" },
								El("input", { type: "checkbox", checked: bgRun, onChange: (e) => setBgRun(e.target.checked) }),
								"后台执行（首次全量播种必勾）")),
						lastRun && lastRun.status === "needs_seed" ? El("div", { className: "wss-row" },
							El("button", { className: "wss-btn primary", disabled: busy !== "", onClick: () => doSeed("push") }, busy === "播种push" ? "推送中…" : "以本机为准（推送到对端）"),
							El("button", { className: "wss-btn primary", disabled: busy !== "", onClick: () => doSeed("pull") }, busy === "播种pull" ? "拉取中…" : "以对端为准（拉取到本机）"),
							El("span", { className: "wss-note" }, "初次同步需要选一个方向")) : null,
						El("p", { className: "wss-note" }, "同步的是上方「工作区」当前选中的目录；冲突时先报计划不动手，确认后新者占原路径、旧者以 .conflict-<时间戳> 在两边共存；删除进回收站，绝不硬删。")),
					// 运行结果
					lastRun ? El("div", { className: "wss-card" },
						El("h3", null, "运行结果"),
						El("pre", { className: "wss-pre" }, JSON.stringify(lastRun, null, 1).slice(0, 4000))) : null,
					El("div", { className: "wss-msg" + (msg.ok ? "" : " err") }, msg.text)));
		}

		// ------------------------------------------------------------ entry --

		let open = false;
		const listeners = new Set();
		const setOpen = (v) => { open = v; for (const l of listeners) l(); };

		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-workspace-sync",
				order: 6,
				label: "工作区同步",
			}, (props) => El(Trigger, { wide: props.wide })));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-workspace-sync-panel",
				order: 11,
			}, () => El(Panel, { onClose: () => setOpen(false) })));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
