# dsh-workspace-sync

DeepSeek Harness 插件：在两台已配对的机器（macOS ↔ Windows）之间 **P2P 同步 DSH 工作区**。

无服务器、无中继、局域网直传（LocalSend 式发现 + 直连），手动显式触发，三方比对，冲突保双，删除进回收站——**绝不静默覆盖，绝不丢一个字节**。

> 设计文档（决策记录与算法论证）：见工作区 `projects/dsh-workspace-sync/DESIGN.md`

## 安装（每台机器各自执行一次）

```sh
dsh plugin --profile web add git+https://github.com/Airls-bubble/dsh-workspace-sync.git
```

DSH 按实际安装状态自动对账 `dsh.profile.bundles`，装完重启 `dsh web` 即生效。卸载：

```sh
dsh plugin --profile web remove dsh-workspace-sync
```

## 快速上手（两台机器，共四步）

```text
① Mac:   对话里说「sync_pair export」→ 得到配对码（DSS1. 开头）
② Win:   「sync_pair import，code=那串码」
③ 确认 Win 端 DSH 从工作区目录启动（或给 Mac 的 row config 配 workspaceRoot）
④ Mac:   「sync_workspace」→ 首次自动播种（Mac → Win 单向全量），之后即为双向同步
```

工具一共有三个：

| 工具 | 作用 |
|---|---|
| `sync_workspace` | 执行同步。`peerId` 多对端时指定对端；`seed:'push'\|'pull'` 显式播种；发现冲突时只报计划，`confirm_conflicts:true` 才落盘；`background:true` 后台执行（首次 4.6GB 全量播种必开，否则工具调用会挂到传完为止） |
| `sync_status` | 本机身份、服务端口、已配对设备、上次同步报告（后台同步时 `syncing:false` 即结束） |
| `sync_pair` | `export` 出配对码 / `import` 导入 / `list` / `forget` / `discover` 浏览局域网在线设备 |

## 配置（可选）

Row config（profile 的 cordis 层，机器本地）：

```yaml
dsh-workspace-sync:
  workspaceRoot: /Volumes/Data/AI   # 默认取 dsh 启动目录（cwd）
  port: 27891                        # 同步服务端口（被占用则回退临时端口）
  deviceName: juweideMac             # mDNS 广播名
  enabled: true
  autoStart: true
```

机器本地状态（身份、令牌、对端表）：`~/.dsh/storages/workspace-sync.json`——**门禁令牌就在这里，别外传这个文件**。工作区侧状态在 `<工作区>/.sync/`（基线、回收站、上次报告），本身永不被同步。

## 同步范围与排除

同步：工作区内一切，**包括** `raw/private/`（你自己的两台机器之间）。

永不同步：`.git/`、`node_modules/`（任意深度）、`.wiki-state/`、`.sync/`、`.DS_Store`、`desktop.ini`、`Thumbs.db`、`*.tmp`、`~*`、符号链接（跳过并报告）。

> Windows 首次播种后，skills 依赖需按 `skills-lock.json` 重装一次（`node_modules` 里的原生二进制跨平台必炸，故不同步）。

## 安全模型（读一遍再用）

- **明文 HTTP 直传，无 TLS**——这是用户明确的裁示（本机局域网场景）。令牌只做**门禁**：未配对设备连 `/sync/ping`（仅回设备名）以外的一切路由都会被 401 拒绝。它防篡改、防陌生人往你工作区写文件，**不防流量窃听**。
- 配对码 = 身份 + 地址 + 令牌，请通过你信任的渠道交换（聊天窗口、AirDrop、U 盘均可）。泄露配对码 = 交出工作区写权限，`sync_pair forget` 可立即吊销对端。
- 笔记本带去公共网络时，同步服务也在那个网络里监听——门禁会挡住陌生人，但洁癖者可在 row config 里 `autoStart: false`，用完再开。

## 语义保证

- **手动显式**：只有你（或对话里的艾莉娅丝）说同步才同步，没有后台自动镜像——工作区是 agent 实时写的，两支笔不抢一张纸。
- **三方比对**：基线（上次同步成功时刻）vs 本机 vs 对端；只有一边变→直接应用；两边都变同一路径→冲突。
- **冲突保双**：新者占据原路径，旧者改名 `xxx.conflict-<时间戳>` 在**两边**共存，报告逐条列出。删除对修改让路（修改胜出，报告说明）。
- **trash > rm**：任何一方因同步产生的删除都进本机 `.sync/trash/<时间戳>/`，可随时捞回。
- **限制**：基线是单一全局的（「上次同步」），两台机器完美适用；三台以上正确性不承诺（无向量时钟），别三台同时改同一文件。

## 面板（Web 半身）

重启 `dsh web` 后，侧边栏底部多一个「工作区同步」入口：本机状态、已配对对端、配对码生成/导入、局域网设备发现、一键同步（含冲突计划确认）都在面板里。数据经 `/workspace-sync/api`（宿主半身 RPC，与 dsh-market 的 `/market/api` 同机制）。

## Windows 侧排障

插件依赖 DSH 的 peer 链接目录（`~/.dsh/profiles/node_modules/@deepseek-ai/`，指向 dsh 本体自带包）来解析 `@deepseek-ai/dsh-tools`。若插件启动后休眠、`~/.dsh/storages/workspace-sync.boot.log` 里出现「dsh-tools 不可解析」，跑一次：

```sh
node <插件目录>\scripts\link-peers.js
```

它会为缺失的 @deepseek-ai 包补建 junction（无需管理员权限），完成后重启 dsh。

## 开发

```sh
npm install        # bonjour-service 是唯一运行时依赖；@deepseek-ai/* peer 由 profile 提供
node --test test/engine.test.js test/sync.test.js
```

`test/sync.test.js` 是真实回环：两个服务、两个临时工作区、真 HTTP，覆盖播种/合并/删除/冲突/门禁/路径收容全生命周期。

## License

MIT
