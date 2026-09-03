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
:root{--wss-text:#252525;--wss-text2:#5f6670;--wss-brand:#4d6bfe;--wss-brand-hover:#2e4bd8;--wss-border:#e5e7eb;--wss-border-strong:#d4d7dc;--wss-divider:#eef0f2;--wss-panel:#ffffff;--wss-card:#ffffff;--wss-field:#f9fafb;--wss-btn:#ffffff;--wss-btn-hover:#f3f4f6;--wss-hover:#f3f4f6;--wss-code-text:#374151;--wss-ok:#15803d;--wss-ok-bg:#e8f6ee;--wss-err:#b91c1c;--wss-err-bg:#fdeaea;--wss-off:#6b7280;--wss-off-bg:#f3f4f6;--wss-backdrop:rgba(20,22,28,.42);--wss-shadow:0 8px 40px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.08)}
.wss-wrap{display:flex;flex-direction:column;min-height:0;width:100%;color:var(--wss-text);font-size:13px;color-scheme:light}
.wss-sect{width:100%;display:flex;flex-direction:column;gap:12px;padding-bottom:8px}
.wss-sect-head{display:flex;align-items:center;gap:8px;padding:2px 0}
.wss-sect-head svg{width:18px;height:18px;color:var(--wss-brand);flex:none}
.wss-sect-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,var(--wss-text))}
.wss-sect-sub{margin-left:auto;font-size:11px;color:var(--wss-text2)}
.wss-short{font:600 26px ui-monospace,Menlo,monospace;letter-spacing:6px;color:var(--wss-brand)}
.wss-details{margin-top:8px}
.wss-details summary{cursor:pointer;color:var(--wss-text2);font-size:11.5px;user-select:none}
.wss-details[open] summary{margin-bottom:8px}
.wss-body{flex:1;min-height:0;overflow-y:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:12px}
.wss-card{border:1px solid var(--wss-border);border-radius:11px;padding:13px 14px;background:var(--wss-card)}
.wss-card h3{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--wss-text);display:flex;align-items:center;gap:6px}
.wss-kv{display:flex;gap:8px;margin:3px 0;font-size:12.5px;line-height:1.5}
.wss-k{color:var(--wss-text2);flex:none;width:88px}
.wss-v{word-break:break-all;color:var(--wss-text)}
.wss-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
.wss-input{flex:1;min-width:180px;background:var(--wss-field);color:var(--wss-text);border:1px solid var(--wss-border-strong);border-radius:6px;padding:5px 9px;font:inherit}
.wss-input::placeholder{color:var(--wss-text2);opacity:.75}
.wss-check{display:flex;align-items:center;gap:5px;margin-left:auto;font-size:12px;color:var(--wss-text);cursor:pointer}
.wss-browser{margin-top:8px;border:1px solid var(--wss-border);border-radius:8px;padding:8px;max-height:240px;overflow:auto;background:var(--wss-field)}
.wss-dirlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px;margin-top:6px}
.wss-dirlist .wss-btn{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;justify-content:flex-start}
.wss-btn{cursor:pointer;border:1px solid var(--wss-border);background:var(--wss-btn);color:var(--wss-text);border-radius:8px;padding:5px 12px;font-size:12.5px;font-weight:500;font-family:inherit}
.wss-btn:hover{background:var(--wss-btn-hover)}
.wss-btn:disabled{opacity:.45;cursor:not-allowed}
.wss-btn.primary{background:var(--wss-brand);border-color:var(--wss-brand);color:#fff}
.wss-btn.primary:hover{background:var(--wss-brand-hover);border-color:var(--wss-brand-hover)}
.wss-btn.danger{color:var(--wss-err);border-color:var(--wss-err)}
.wss-btn.danger:hover{background:var(--wss-err-bg)}
.wss-code{width:100%;box-sizing:border-box;border:1px solid var(--wss-border-strong);border-radius:8px;padding:8px 10px;font:12px ui-monospace,Menlo,monospace;background:var(--wss-field);color:var(--wss-code-text);resize:vertical}
.wss-pre{margin:8px 0 0;padding:9px 11px;background:var(--wss-field);border:1px solid var(--wss-border);border-radius:8px;font:11.5px ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow-y:auto;color:var(--wss-code-text)}
.wss-msg{font-size:12px;color:var(--wss-ok);min-height:16px}
.wss-msg.err{color:var(--wss-err)}
.wss-peer{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--wss-border);font-size:12.5px}
.wss-peer:last-child{border-bottom:none}
.wss-peer .name{font-weight:600}
.wss-peer .id{color:var(--wss-text2);font-family:ui-monospace,Menlo,monospace;font-size:11px}
.wss-badge{font-size:11px;padding:1px 8px;border-radius:9px;background:var(--wss-ok-bg);color:var(--wss-ok)}
.wss-badge.off{background:var(--wss-off-bg);color:var(--wss-off)}
.wss-note{font-size:11.5px;color:var(--wss-text2);line-height:1.6;margin:6px 0 0}
@media (prefers-color-scheme:dark){:root{--wss-text:#e8eaf0;--wss-text2:#9aa3b2;--wss-brand:#4d6bfe;--wss-brand-hover:#3b55d9;--wss-border:#2a2a35;--wss-border-strong:#3a3a48;--wss-divider:#26262f;--wss-panel:#16161c;--wss-card:#1e1e27;--wss-field:#121218;--wss-btn:#26262f;--wss-btn-hover:#30303c;--wss-hover:#26262f;--wss-code-text:#cdd3de;--wss-ok:#4ade80;--wss-ok-bg:rgba(74,222,128,.14);--wss-err:#f87171;--wss-err-bg:rgba(248,113,113,.12);--wss-off:#9aa3b2;--wss-off-bg:rgba(148,163,184,.14);--wss-backdrop:rgba(0,0,0,.55);--wss-shadow:0 8px 40px rgba(0,0,0,.5)}.wss-wrap{color-scheme:dark}}
:root[style*="color-scheme: dark"]{--wss-text:#e8eaf0;--wss-text2:#9aa3b2;--wss-brand:#4d6bfe;--wss-brand-hover:#3b55d9;--wss-border:#2a2a35;--wss-border-strong:#3a3a48;--wss-divider:#26262f;--wss-panel:#16161c;--wss-card:#1e1e27;--wss-field:#121218;--wss-btn:#26262f;--wss-btn-hover:#30303c;--wss-hover:#26262f;--wss-code-text:#cdd3de;--wss-ok:#4ade80;--wss-ok-bg:rgba(74,222,128,.14);--wss-err:#f87171;--wss-err-bg:rgba(248,113,113,.12);--wss-off:#9aa3b2;--wss-off-bg:rgba(148,163,184,.14);--wss-backdrop:rgba(0,0,0,.55);--wss-shadow:0 8px 40px rgba(0,0,0,.5)}
:root[style*="color-scheme: dark"] .wss-wrap{color-scheme:dark}
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

		class Shield extends react.Component {
			constructor(p) { super(p); this.state = { err: null }; }
			static getDerivedStateFromError(e) { return { err: e }; }
			render() {
				if (!this.state.err) return this.props.children;
				return El("pre", { className: "wss-pre", style: { margin: "0" } },
					"面板渲染出错（把这段发给艾莉娅丝）：\n" + String((this.state.err && this.state.err.stack) || this.state.err));
			}
		}

		function Kv(props) {
			return El("div", { className: "wss-kv" }, El("span", { className: "wss-k" }, props.k), El("span", { className: "wss-v" }, props.v));
		}

		function Panel(props) {
			const [status, setStatus] = h(props.__initialStatus ?? null);
			const [busy, setBusy] = h("");
			const [msg, setMsg] = h({ ok: true, text: "" });
			const [pairCode, setPairCode] = h("");
			const [importText, setImportText] = h("");
			const [shortInput, setShortInput] = h("");
			const [found, setFound] = h(null);
			const [lastRun, setLastRun] = h(null);
			const [showConfirm, setShowConfirm] = h(false);
			const [browser, setBrowser] = h(null); // {path,parent,dirs,home,label}
			const [pathInput, setPathInput] = h("");
			const [bgRun, setBgRun] = h(false);
			const [scope, setScope] = h(null); // {excludes,hash,hard,note}
			const [scopeText, setScopeText] = h("");

			const refresh = async () => {
				try { setStatus(await api("status")); } catch (e) { setMsg({ ok: false, text: String(e.message || e) }); }
				try {
					const sc = await api("getScope");
					setScope(sc);
					const editing = typeof document !== "undefined" && document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-wss") === "scope";
					if (!editing) setScopeText(sc.excludes.join("\n"));
				} catch {}
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
							El("p", { className: "wss-note", key: "note" }, "每台机器各选各的根目录；基线随目录存在各自 .sync/ 下，切换互不影响。"),
							El("div", { key: "scope" },
								El("p", { className: "wss-note", style: { marginBottom: "4px" } }, "同步范围——排除规则（一行一个：name/ 排除目录，*.tmp 匹配文件名，a/b/c 排除路径）："),
								El("textarea", {
									className: "wss-code", rows: 4, value: scopeText, "data-wss": "scope",
									placeholder: ".git/\nnode_modules/\n*.tmp",
									onChange: (e) => setScopeText(e.target.value),
								}),
								El("div", { className: "wss-row" },
									El("button", {
										className: "wss-btn", disabled: busy !== "",
										onClick: act("scope", async () => {
											const r = await api("setScope", { excludes: scopeText });
											if (!r.ok) { setMsg({ ok: false, text: r.error }); return; }
											const sc = await api("getScope");
											setScope(sc); setScopeText(sc.excludes.join("\n"));
											setMsg({ ok: true, text: "排除规则已保存（指纹 " + r.hash + "）。两边机器的规则必须一致，否则同步会被拒绝。" });
										}),
									}, "保存排除规则"),
									scope ? El("span", { className: "wss-note", style: { margin: "0" } }, "指纹 " + scope.hash) : null),
								scope ? El("p", { className: "wss-note" }, "永不同步（不可配置）：" + scope.hard.join("、") + "。已排除文件的两机副本都不动，也不传播删除。") : null),
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
							: El("p", { className: "wss-note" }, "还没有对端。让对方在其面板点「生成配对短码」，然后在下面输入这串数字；或发现设备后一键配对。"),
						El("div", { className: "wss-row" },
							El("button", { className: "wss-btn", disabled: busy !== "", onClick: act("discover", async () => { setFound(await api("discover")); }) }, "发现局域网设备"))),
					// 配对：短码为主，完整码收进「高级」
					El("div", { className: "wss-card" },
						El("h3", null, "配对"),
						status && status.pairOffer ? El("div", { className: "wss-row" },
							El("span", { className: "wss-short" }, status.pairOffer.code),
							El("span", { className: "wss-note" }, "本机配对短码 · 10 分钟内有效"),
							El("button", { className: "wss-btn danger", disabled: busy !== "", onClick: act("offerstop", async () => { await api("pairOfferCancel"); await refresh(); setMsg({ ok: true, text: "配对短码已作废。" }); }) }, "作废"))
							: El("div", { className: "wss-row" },
								El("button", { className: "wss-btn primary", disabled: busy !== "", onClick: act("offer", async () => { await api("pairOfferStart"); await refresh(); setMsg({ ok: true, text: "短码已生成。10 分钟内在对端输入这串数字即可完成配对。" }); }) }, "生成配对短码")),
						El("div", { className: "wss-row" },
							El("input", { className: "wss-input", style: { maxWidth: "150px" }, placeholder: "输入对方短码", maxLength: 6, value: shortInput, onChange: (e) => setShortInput(e.target.value.replace(/\D/g, "")) }),
							El("button", {
								className: "wss-btn primary", disabled: busy !== "" || shortInput.length !== 6,
								onClick: act("shortpair", async () => {
									const r = await api("pairImport", { code: shortInput });
									setShortInput(""); await refresh();
									setMsg({ ok: true, text: "已配对：" + r.peer.name + "（" + r.peer.url + "）" });
								}),
							}, busy === "短码" ? "配对中…" : "短码配对")),
						found ? El("div", { style: { marginTop: "10px" } },
							El("p", { className: "wss-note" }, "局域网在线：", found.online.length === 0 ? "（无）" : null),
							found.online.map((d) => El("div", { className: "wss-peer", key: d.id },
								El("span", { className: "name" }, d.name),
								d.pair ? El("span", { className: "wss-badge" }, "待配对 " + d.pair) : El("span", { className: "id" }, d.url),
								d.pair ? El("button", { className: "wss-btn", style: { marginLeft: "auto" }, disabled: busy !== "", onClick: act("claim:" + d.id, async () => { const r = await api("pairImport", { code: d.pair }); await refresh(); setMsg({ ok: true, text: "已配对：" + r.peer.name }); }) }, "配对") : null))) : null,
						El("details", { className: "wss-details" },
							El("summary", null, "高级：完整配对码（跨网段或聊天工具手动传）"),
							El("div", { className: "wss-row" },
								El("button", { className: "wss-btn", disabled: busy !== "", onClick: act("export", async () => { const r = await api("pairExport"); setPairCode(r.code); }) }, "生成本机完整配对码")),
							pairCode ? [
								El("textarea", { key: "c", className: "wss-code", rows: 3, readOnly: true, value: pairCode, onFocus: (e) => e.target.select() }),
								El("div", { className: "wss-row", key: "cb" },
									El("button", { className: "wss-btn", onClick: () => { navigator.clipboard.writeText(pairCode).then(() => setMsg({ ok: true, text: "已复制" })); } }, "复制"),
									El("button", { className: "wss-btn", onClick: () => setPairCode("") }, "收起")),
							] : null,
							El("textarea", { className: "wss-code", rows: 2, placeholder: "粘贴对方的完整配对码（DSS1. 开头）…", value: importText, onChange: (e) => setImportText(e.target.value) }),
							El("div", { className: "wss-row" },
								El("button", {
									className: "wss-btn", disabled: busy !== "" || !importText.trim(),
									onClick: act("import", async () => {
										const r = await api("pairImport", { code: importText.trim() });
										setImportText(""); await refresh();
										setMsg({ ok: true, text: "已配对：" + r.peer.name + "（" + r.peer.url + "）" });
									}),
								}, "导入完整配对码")))),
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
		// 设置页左栏独立分区：settings.section 的契约是「a whole page is
		// settings.section」（见 dsh-cordis-client-runner 的槽文档），与
		// settings-general 的「通用设置」(general)、settings-models 的「模型」
		// 同级；皮肤管理占位由主题包自己的 section 贡献。label 为函数，随
		// 分区列表渲染；组件不收 props，页面内容全部自绘（同契约说明）。
		function SettingsSection() {
			return El("div", { className: "wss-sect" },
				El("div", { className: "wss-sect-head" },
					El(SyncIcon, { size: 18 }),
					El("span", { className: "wss-sect-title" }, "工作区同步"),
					El("span", { className: "wss-sect-sub" }, "局域网 P2P 同步")),
				El(Shield, null, El(Panel)));
		}

		const inject = ["slots"];
		function apply(ctx) {
			try { injectStyle(); } catch {}
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "workspace-sync",
				order: 30,
				label: () => "工作区同步",
			}, () => El(SettingsSection)));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__test = { Panel, Shield, SettingsSection };
		return module.exports;
	},
});
