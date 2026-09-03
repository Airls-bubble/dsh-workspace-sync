# dsh-workspace-sync

DeepSeek Harness 插件：在局域网内 P2P 同步 DSH 工作区。

任何两台装了本插件的机器都能配对互同步，不限系统和组合：Mac ↔ Win、Mac ↔ Mac、Win ↔ Win 都可以，三台以上则两两配对、按星型拓扑逐对同步。依赖是纯 JavaScript（HTTP 传输加 mDNS 发现），没有平台专属代码。

无服务器、无中继，手动显式触发。同步走三方比对：冲突时两边都保留，新者占原路径，旧者改名 `xxx.conflict-<时间戳>`；删除进回收站，不静默覆盖。

## 安装（每台机器各自执行一次）

```sh
dsh plugin --profile web add git+https://github.com/Airls-bubble/dsh-workspace-sync.git
```

DSH 按实际安装状态自动对账 `dsh.profile.bundles`，装完重启 `dsh web` 即生效。卸载：

```sh
dsh plugin --profile web remove dsh-workspace-sync
```

## 快速上手

```text
① 机器A：面板「生成配对短码」或对话里说「sync_pair offer」→ 得到 6 位数字（10 分钟有效）
② 机器B：把 6 位短码输进面板（或对话里「sync_pair import，code=123456」）→ 完成配对
   （万一局域网多播不通：面板「高级」里改用 DSS1. 完整配对码，聊天工具手动传）
③ 确认两台机器各自的工作区目录（面板里选，或配 row config）
④ 任意一侧发起「sync_workspace」：首次同步没有基线，需要选一个播种方向
   （发起方→对端为 push，反过来为 pull），之后即为双向同步
```

对话工具有三个：

| 工具 | 作用 |
|---|---|
| `sync_workspace` | 执行同步。`peerId` 多对端时指定对端；`seed:'push'\|'pull'` 显式播种；发现冲突时只报计划，`confirm_conflicts:true` 才落盘；`background:true` 后台执行，大工作区首次全量播种建议开启 |
| `sync_status` | 本机身份、服务端口、当前工作区、已配对设备、上次同步报告（后台同步时 `syncing:false` 即结束） |
| `sync_pair` | `offer` 生成 6 位短码（10 分钟） / `export` 出完整配对码（跨网段备用） / `import` 导入（6 位短码或完整码均可） / `list` / `forget` / `discover` 浏览局域网在线设备 |

## 面板

重启 `dsh web` 后，设置页左栏多出「工作区同步」分区（与「通用设置」「模型」同级），全部操作都在这个页面里完成：

- 工作区选择：服务端目录浏览器，Windows 列盘符，macOS 从根目录浏览，历史目录一键切回。每台机器各选各的根，基线随目录存在各自 `.sync/` 下，切换互不影响。
- 配对：6 位短码（生成短码 → 对端输入 / 发现设备后一键配对）；完整配对码收进「高级」作为跨网段备用。
- 同步（可选后台执行）、冲突计划确认、运行报告。
- 同步（可选后台执行）、冲突计划确认、运行报告。

数据经 `/workspace-sync/api`，与 dsh-market 的 `/market/api` 同机制。

## 配置（可选）

Row config（profile 的 cordis 层，机器本地）：

```yaml
dsh-workspace-sync:
  workspaceRoot: /Volumes/Data/AI   # 默认取 dsh 启动目录（cwd），面板里可改
  port: 27891                        # 同步服务端口（被占用则回退临时端口）
  deviceName: my-mac-mini            # mDNS 广播名
  enabled: true
  autoStart: true
```

机器本地状态（身份、令牌、对端表）在 `~/.dsh/storages/workspace-sync.json`。门禁令牌就在这个文件里，不要外传。工作区侧状态在 `<工作区>/.sync/`（基线、回收站、上次报告），本身永不被同步。

## 同步范围与排除

默认同步工作区内的一切文件。有两层排除：

**硬排除**（不可配置）：`.sync/`（插件自身状态）、符号链接（跳过并报告）、`.DS_Store`、`desktop.ini`、`Thumbs.db`。

**排除规则**（面板「工作区」卡里编辑，一行一个）：

- `name/` 排除该目录（任意深度）
- `*.tmp` 按文件名匹配（`*` 通配）
- `a/b/c` 排除指定路径及其下内容

全新安装的默认规则是 `.git/`、`node_modules/`、`*.tmp`。升级前已经同步过的老工作区，会把旧版内置清单原样迁成你的规则，升级不改行为。

两条纪律：

- **两台机器的规则必须一致。** 范围不对称会被引擎误判成对端删除。每次同步前两边交换规则指纹，不一致就拒绝执行；首次播种时，发起方的规则会自动被对端采纳。
- **排除永远安全，重新包含要留意。** 把已同步的文件加进排除，两边副本都原样保留，也不传播删除；反过来把排除项删掉让它重新进范围，若两边都有同名文件且无基线记录，会按冲突保双处理。

不想同步的隐私目录（比如个人笔记、密钥文件），写进排除规则即可，默认不同步一切之外的任何东西。

Windows 首次播种后，skills 依赖需按 `skills-lock.json` 重装一次：`node_modules` 里的原生二进制跨平台不兼容，所以默认不同步。

## 安全模型（读一遍再用）

- 传输是明文 HTTP，无 TLS，这是局域网场景下的取舍。令牌只做门禁：未配对设备访问 `/sync/ping`（仅回设备名）以外的一切路由都会被 401 拒绝。它能防篡改、防陌生人往你工作区写文件，不防流量窃听。
- 6 位短码只是局域网内的指针：它告诉对端「哪台机器正在等你」，真正的身份 + 地址 + 令牌走本机 HTTP 取回，与完整配对码同一个信道，安全性不降。短码 10 分钟有效、作废即失效、同一台机器 5 次输错锁 30 秒。
- 完整配对码 = 身份 + 地址 + 令牌。跨网段或作为兜底时用它，请通过你信任的渠道交换（聊天窗口、AirDrop、U 盘均可），别发到公开频道。泄露配对码等于交出工作区写权限；`sync_pair forget` 可立即吊销对端。
- 笔记本带去公共网络时，同步服务也在那个网络里监听。门禁会挡住陌生人；介意的话可在 row config 里 `autoStart: false`，用完再开。

## 语义保证

- 手动显式：只有你（或对话里的 agent）说同步才同步，没有后台自动镜像。工作区是 agent 实时写的，两支笔不抢一张纸。
- 三方比对：基线（上次同步成功时刻）vs 本机 vs 对端。只有一边变就直接应用；两边都改了同一路径才算冲突。
- 冲突保双：新者占据原路径，旧者改名 `xxx.conflict-<时间戳>` 在两边共存，报告逐条列出。删除对修改让路（修改胜出，报告说明）。
- trash 优先于 rm：任何一方因同步产生的删除都进本机 `.sync/trash/<时间戳>/`，可随时捞回。
- 限制：基线是单一全局的（即「上次同步」），两台机器适用。三台以上不承诺正确性（没有向量时钟），避免多台同时改同一个文件。

## 排障：插件休眠（dsh-tools 不可解析）

插件依赖 DSH 的 peer 链接目录（`~/.dsh/profiles/node_modules/@deepseek-ai/`，指向 dsh 本体自带包）来解析 `@deepseek-ai/dsh-tools`。若插件启动后休眠，`~/.dsh/storages/workspace-sync.boot.log` 里出现「dsh-tools 不可解析」，跑一次：

```sh
node <插件目录>\scripts\link-peers.js
```

它会为缺失的 @deepseek-ai 包补建链接（Windows 上是 junction，无需管理员权限；macOS/Linux 是符号链接），完成后重启 dsh。

## 开发

```sh
npm install   # bonjour-service 是唯一运行时依赖；@deepseek-ai/* peer 由 profile 提供
npm test      # pretest 会先自动重建仓库内 peer 链接，再跑全部测试
```

`test/sync.test.js` 是真实回环：两个服务、两个临时工作区、真 HTTP，覆盖播种、合并、删除、冲突、门禁、路径收容的完整生命周期。`test/render.test.js` 与 `test/data-shapes.test.js` 用真实 react-dom/server 渲染面板，后者喂入完整 RPC 数据形态。面板的几场线上事故都栽在「空数据能过、真数据必炸」上，这套测试就是为此生的。

## License

MIT
