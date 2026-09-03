/**
 * tools.js — the chat-facing surface. Three tools, mirroring vision-plugin
 * idioms (defineTool + JSON output + render helper).
 *
 * defineTool is INJECTED by index.js (lazy-loaded there) — this module never
 * imports @deepseek-ai/* statically, so a missing peer can never fail module
 * evaluation and take DSH boot down with it.
 */

export function registerTools(tools, svc, log, defineTool) {
  const renderJson = (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }];
  tools.register(
    defineTool({
      name: "sync_workspace",
      description:
        "与已配对的另一台机器双向同步当前 DSH 工作区（艾莉娅丝的工作区同步插件）。首次使用需先在两台机器上用 sync_pair 交换配对码。发现冲突时只报计划不动手，需 confirm_conflicts:true 才落盘（冲突保留双方，绝不丢数据）。",
      parameters: {
        peerId: { type: "string", description: "目标对端设备 id（多对端时必填；只有一个对端时可省略）" },
        seed: { type: "string", description: "初始播种方向（仅首次、无基线时）：'push'=本机为真源覆盖对端，'pull'=对端为真源覆盖本机" },
        confirm_conflicts: { type: "boolean", description: "确认执行含冲突的同步计划（冲突保留双方版本）" },
        background: { type: "boolean", description: "后台执行：立即返回，用 sync_status 查进度（首次全量播种 4.6GB 建议开启）" },
      },
      output: { schema: { type: "json" }, render: renderJson },
      async execute(args) {
        const a = args && typeof args === "object" ? args : {};
        try {
          return await svc.runSync({
            peerId: typeof a.peerId === "string" && a.peerId ? a.peerId : undefined,
            seed: a.seed === "push" || a.seed === "pull" ? a.seed : undefined,
            confirmConflicts: a.confirm_conflicts === true,
            background: a.background === true,
          });
        } catch (e) {
          return { ok: false, status: "error", error: String((e && e.message) || e) };
        }
      },
    }),
  );

  tools.register(
    defineTool({
      name: "sync_status",
      description: "查看工作区同步插件状态：本机设备身份、同步服务端口、已配对对端、上次同步报告摘要。",
      parameters: {},
      output: { schema: { type: "json" }, render: renderJson },
      async execute() {
        try {
          return { ok: true, ...svc.status() };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    }),
  );

  tools.register(
    defineTool({
      name: "sync_pair",
      description:
        "工作区同步设备配对：action='export' 生成本机配对码（交给人带到另一台机器）；action='import' 导入对方配对码（code 参数）；action='list' 列出已配对设备；action='forget' 删除某个对端（peerId 参数）；action='discover' 浏览局域网上在线的同步设备（未配对也能看到，配对仍需交换配对码）。",
      parameters: {
        action: { type: "string", description: "export | offer | import | list | forget | discover" },
        code: { type: "string", description: "action='import' 时：对方的 6 位短码或 DSS1. 完整配对码" },
        peerId: { type: "string", description: "action='forget' 时：要删除的对端设备 id" },
      },
      output: { schema: { type: "json" }, render: renderJson },
      async execute(args) {
        const a = args && typeof args === "object" ? args : {};
        try {
          switch (a.action) {
            case "export":
              return { ok: true, ...svc.pairExport(), hint: "把 code 完整复制到另一台机器执行 sync_pair action:'import'。" };
            case "import":
              if (typeof a.code !== "string" || !a.code.trim()) return { ok: false, error: "import 需要 code 参数（对方机器的 6 位短码或 DSS1. 完整配对码）" };
              return svc.importPairCode(a.code);
            case "offer":
              return { ok: true, ...svc.startPairOffer(), hint: "把 6 位短码念给/发给另一台机器，在其面板或 sync_pair import 里输入即可完成配对；10 分钟内有效。" };
            case "list":
              return { ok: true, peers: svc.pairList() };
            case "forget":
              if (typeof a.peerId !== "string" || !a.peerId) return { ok: false, error: "forget 需要 peerId 参数" };
              return svc.pairForget(a.peerId);
            case "discover":
              return { ok: true, online: await svc.pairDiscover(), hint: "发现的设备仍需交换配对码才能同步（门禁令牌不通过网络传输）。" };
            default:
              return { ok: false, error: "action 必须是 export / import / list / forget / discover" };
          }
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    }),
  );
  log("tools registered: sync_workspace, sync_status, sync_pair");
}
