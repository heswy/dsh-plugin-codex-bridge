# dsh-plugin-codex-bridge

让 **Codex 与 DSH 开发会话协作**：不重启桌面、不抢会话写锁、不接管 Git。

- **进来** —— 外部驱动（Codex 等）经本地 RPC 驱动独立 DSH 宿主建好的**工作区**，会同步进你正在运行的桌面窗口：点侧栏底部的刷新按钮就能看到，不用重启。
- **投递** —— 外部进程把 JSON 写进 `~/.dsh/inbox/`，由**会话锁的持有者**（桌面进程）用 `sessionController.prompt` 代为投进目标会话，绕开 `session/writer-held`，但不改变写锁语义。
- **交回** —— DSH 开发会话完成并推送后，用配套 skill [`skills/dsh2codex/`](skills/dsh2codex/) 经 `codex queue` 把交接通知恰好一次地发回主管 Codex 对话（协议见 [docs/codex-handoff.md](docs/codex-handoff.md)）。

**安装**：设置 → 插件 → 添加插件，填仓库地址 / 包名 / 本地目录都行。装完自验三件事——
插件页出现 `dsh-plugin-codex-bridge`；侧栏底部（设置旁）出现刷新图标；`~/.dsh/inbox/sessions.json` 每隔约 10 秒刷新。
本包**零 npm 依赖**（只用 `node:` 内置模块与 Host 服务），本地目录安装是秒级、离线可成。详见下方[安装](#安装)。

## 仓库结构

| 路径 | 是什么 | 装到哪 |
|---|---|---|
| 仓库根 | DSH 插件：工作区同步 + 文件投递箱（反向通道） | 设置 → 插件 → 添加插件 |
| [`skills/dsh2codex/`](skills/dsh2codex/) | DSH 侧 skill：开发完成后交回主管 Codex（正向通道） | `~/.dsh/skills/dsh2codex/` |
| [`codex-skills/codex2dsh/`](codex-skills/codex2dsh/) | Codex 侧 skill：向 DSH 派活、回意见、建工作区 | `~/.codex/skills/codex2dsh/` |
| [`docs/`](docs/) | 交接协议、给 Codex 的说明 | — |
| [`tests/`](tests/) | 插件测试 34 条（`node tests/harness.mjs` 等） | — |

两个 skill 各自带自己的许可证与署名，可独立分发：

```sh
cp -R skills/dsh2codex         ~/.dsh/skills/
cp -R codex-skills/codex2dsh   ~/.codex/skills/
```

> 只装插件也能用「工作区同步 + 由 Codex 投递消息给你」；**双向**协作才需要两个 skill 都在位。

---

## 问题是什么（本机实测，2026-10-13）

| 事实 | 证据 |
|---|---|
| 会话与工作区数据**只有一份**，在 `~/.dsh/` 下共享 | `~/.dsh/sessions/`、`~/.dsh/storages/workspace.json` |
| profile 只隔离**配置 / 插件**，不隔离数据 | `~/.dsh/profiles/desktop/`、`~/.dsh/profiles/web/` 里只有 `cordis.yml`、`cordis.patch.yml`、`package.json`、`node_modules`，**没有任何 storages** |
| 独立 Web 实例建的会话，桌面能打开并**继续写** | 桌面 14:36 重启后对 `session-8734a6fd-…` 加锁、14:37 写入同一条会话日志 |
| 但工作区**列表**不会跟着变 | 工作区注册表只在**空库时**按会话历史引导一次，之后不再重扫；其自身文档写明"外部变更延迟可见 —— 项目只能在下次刷新或重启后反映出来" |
| 两个活着的宿主还会互相覆盖 | 谁最后写领域文件谁生效，外部注册项会被桌面随后的任一次写入抹掉 |

结果：外部建的会话在桌面上显示在**"未分组"**下（"未分组"正是"会话所属工作区不在工作区列表里"的落点）。

## 它做什么

宿主半每 `intervalMs`（默认 5s）跑一次对账，**只增不改**：

1. 读共享的 `storages/workspace.json`（当普通文件读，所以看到的是**外部真相**，
   而不是本进程自己的内存副本），取出所有已登记的工作区路径；
2. （**默认不做**，需把 `includeUngroupedSessions` 打开）再取 `sessionQuery.listSessions()` 的 `header.cwd`，作为"有会话跑过、但没有工作区覆盖"的候选目录；
3. 凡是**在共享文件里存在、但本地活注册表里没有**、且目录仍然存在的 → 调
   `ctx.workspaceRegistry.create(path)` 补上。这一步就是全部关键：它既持久化记录，
   又在 workspace follow 流上发布变更，**已经打开的侧栏因此自己就更新了**；
4. 对**成员为空**的工作区，把 cwd 落在它里面的会话用 `attachSession(sessionId)` 归组
   （注册表自己的校验会复核 header.cwd 是否解析到该路径，不合适的会被拒绝而不是硬塞）。

永不重命名、永不重排、永不归档、永不删除任何工作区。

## 删除会被记住（为什么需要这一层）

DSH 删除工作区时**不动文件夹、不动会话历史**——被删掉的工作区的会话会显示在"未分组"下，
于是它和"有会话跑过、但从来没登记过工作区"长得一模一样。任何"从会话目录反推工作区"的规则
都会把用户删掉的工作区又登记回来，表现出来就是"**我删了，刷新一下它又回来了**"。

这个插件用两层挡住它：

1. **推断默认关闭**（`includeUngroupedSessions: false`），默认情况下根本不会从会话目录反推；
2. **删除记忆**：任何从活注册表里消失的路径都会被记进 `tombstones`（持久化在 `stateFile`，
   默认 `~/.dsh/workspace-sync/state.json`）。推断出的候选命中名单就跳过，记在每轮结果的
   `suppressed` 里。只有**显式登记**（另一个宿主把工作区写进共享文件）才覆盖删除记忆——
   那是明确指令而非推断；用户手动重新添加工作区同样会解除它。

所以：你删掉的工作区不会因为刷新回来；删除记忆重启后依然有效；只有删掉状态文件才会丢失它
（那时只会重新学习一遍，而推断默认关闭，不会立刻复活任何东西）。

## 安装

本包是一个标准 DSH **组合包（bundle）**：`package.json` 声明了
`dsh.bundle.patch` 与 `dsh.client.platform`，因此可以被 DSH 自带的插件管理器直接安装。

**推荐：设置 → 插件 → 添加插件**，三种填法都支持：

| 填什么 | 例子 | 需要什么 |
|---|---|---|
| 本地目录路径 | `/Users/你/plugins/dsh-plugin-codex-bridge` | 绝对路径即可（秒级、离线可成，因为本包零 npm 依赖） |
| GitHub 仓库地址 | `https://github.com/<you>/dsh-plugin-codex-bridge` | 先把本目录推成仓库 |
| 包名 | `dsh-plugin-codex-bridge` | 已发布到 npm（或配置了私有 registry / fallbackRegistries） |

安装完成后它出现在插件列表里，可以逐条停用 / 启停 / 卸载；卸载会从
`dsh.profile.bundles` 移除并 `pnpm remove`。

**装完自己验三件事**（不用看日志）：

1. 插件页里出现 `dsh-plugin-codex-bridge`，状态启用；
2. 桌面侧栏底部（设置旁边）出现刷新图标；
3. `~/.dsh/inbox/sessions.json` 开始刷新（约 10 秒一次，`count` 是当前可见会话数）。

停用 / 卸载后再想临时开回来，也可以走"开发模式"手工挂载（见
`cordis.patch.yml` 顶部注释）：在 profile 的 `cordis.patch.yml` 里 insert 一行、
`name` 指向 `lib/index.js` 的绝对路径。**注意两种方式不要同时用**，否则同一条
`workspace-sync` 行会被挂两次。

**能力自检**：本包刻意**不声明** `@deepseek-ai/dsh-*` 的 peerDependencies（这样任何 DSH
版本都能装），代价是拿不到版本闸门。作为替代，插件每轮对账都会跑一次机械自检
（服务形状、共享域文件、可写目录、工作区实体形状），漂移时在日志里明确报错，并把结果
放在 `GET /api/workspace-sync` 的 `doctor` 字段（也可 `?action=doctor` 现跑一次）。

## 配置

按机器覆写配置时，**写在 profile 自己的 `cordis.patch.yml` 里**（它在所有 bundle 层之后生效）：

```yaml
- id: workspace-sync
  config:
    intervalMs: 15000
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `routePath` | `/api/workspace-sync` | 客户端按钮用的路由，必须以 `/api/` 开头 |
| `registryFile` | `<DSH_HOME>/storages/workspace.json` | 共享工作区文件；`DSH_HOME` 缺省为 `~/.dsh` |
| `autoSync` | `true` | 是否定时对账 |
| `intervalMs` | `5000` | 对账周期（夹在 1000–600000） |
| `includeUngroupedSessions` | **`false`** | 是否把"有会话跑过但无工作区"的目录也注册。**默认关闭**：删除工作区不删文件夹与会话，打开这条推断会把删掉的工作区又登记回来（见"删除会被记住"） |
| `stateFile` | `<DSH_HOME>/workspace-sync/state.json` | 删除记忆（`lastSeen` + `tombstones`）的存放位置 |
| `attachSessions` | `true` | 是否给空成员工作区归组会话 |
| `excludeDshHome` | `true` | 不注册 `DSH_HOME` 下的目录（`~/.dsh/bot/workspace` 这类内部目录） |
| `maxAddsPerPass` | `20` | 单次对账最多新增几个（防止一次性刷屏） |
| `inbox.enabled` | `true` | 是否启用投递箱 |
| `inbox.dir` | `<DSH_HOME>/inbox` | 投递箱目录 |
| `inbox.intervalMs` | `1000` | 取件周期 |
| `inbox.allowSteer` | `false` | 是否允许 `steer`（插话到正在跑的轮次） |
| `inbox.maxTextBytes` | `200000` | 单条正文上限 |
| `inbox.indexIntervalMs` | `10000` | 会话索引刷新周期 |
| `verbose` | `false` | 每轮都打日志，而不只是在有变更时 |

## 接口

```
GET  api/workspace-sync              # 状态：配置 + 最近一次对账结果
POST api/workspace-sync?action=sync  # 立刻对账一次，返回本次结果
```

## 界面

侧栏底部、设置旁边一个刷新图标（槽位 `sidebar.footer.action`，id `workspace-sync`）。
点一下 → 宿主立刻对账 → 列表自己更新。悬停提示会说明结果（新增 N 个 / 无需添加 / 失败原因）。

## 投递箱：把指令交给「会话锁的持有者」

新建任务不需要这个；**往一条已经打开的会话里投递消息**才需要。

一条 Session 只有一个写者。桌面窗口打开某条会话时持有它的 `session.lock`，另一个
宿主进程去写就会拿到 `session/writer-held` —— 这是设计，不是 bug（两个进程同时写
会把会话日志写坏）。所以消息只能由**持有锁的那个进程**投递，而这个插件正好跑在
桌面进程里：别的进程把 JSON 丢进 `$DSH_HOME/inbox/`，插件取走并用
`sessionController.prompt(...)` 投进目标会话。

### 请求格式

`$DSH_HOME/inbox/<任意名>.json`

```json
{
  "sessionId": "session-7502f96e-6e67-42dd-9994-ef3d51b4b326",
  "text": "请修复 PR #10 的审查意见，并在原分支补回归",
  "mode": "queue",
  "id": "codex-2026-10-13-1",
  "from": "codex"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 id（见 `inbox/sessions.json`） |
| `text` | 是 | 消息正文，非空白，≤ `inbox.maxTextBytes` |
| `mode` | 否 | `queue`（默认）排队等当前轮次结束；`steer` 中途插话，**默认被拒** |
| `id` | 否 | 幂等键，默认取文件名。同一 id 重投不会重复插消息 |
| `from` | 否 | 写进回执便于溯源 |

### 结果去哪看

| 路径 | 内容 |
|---|---|
| `inbox/receipts/<id>.json` | 每条请求的处理结果：`ok` / `accepted` / `mode` / `targetRunning` / `queuedBehindRunningTurn` / 失败时的 `code` |
| `inbox/rejected/<id>.json` | 格式错或被拒的请求，原样保留 |
| `inbox/sessions.json` | 宿主发布的会话索引（`sessionId` / `cwd` / `running`），发送端据此挑 id |

### 不打断保证

- `mode` 默认 `queue`：正在跑的轮次不受影响，消息等这一轮结束才被处理——回执里的
  `queuedBehindRunningTurn: true` 就是这个含义；
- `steer` 默认拒绝（想开就在 profile patch 里设 `inbox.allowSteer: true`）；
- 插件从不取消、不中断、不归档、不抢锁；投递失败只写回执，不会反复重试打搅会话。

### 发送端

```sh
node tools/send.mjs --list
node tools/send.mjs --session session-7502f96e-… --text "…" --from codex
```

退出码：`0` 已投递 / `1` 被拒或投递失败 / `2` 用法错误或等不到回执。
用 `--id` 重投同一条请求是幂等的，可安全重试。

## 测试

```sh
node tests/harness.mjs    # 15 条：工作区对账 + 删除记忆
node tests/inbox.mjs      # 10 条：投递箱（含 steer 拒绝、并发取件、各类拒绝路径）
node tests/relay-e2e.mjs  #  5 条：真发送端 CLI ↔ 真投递箱（模拟宿主按周期取件）
node tests/dry-run.mjs    # 只读预演：对这台机器现在会新增哪些工作区
```

`harness.mjs` 覆盖：外部登记项补齐、已登记者跳过、目录不存在跳过、canonical 去重
（symlink / 尾斜杠）、会话目录候选与其开关、`DSH_HOME` 排除、单次预算、
创建失败不中断整轮、归组会话、已被记账的工作区不动、归组被拒的记录、
共享文件损坏只告警、GET/POST 与路由注销。

## 已知限制

- **宿主半的代码改动需要重启 DSH 才生效**（profile patch 里**新增行**会热生效；
  改 `lib/index.js` 的内容不会换掉已加载的模块）。客户端半（`lib/client.js`）不需要重启。
- 桌面端**不是**实时推送：数据是拉过来的，靠 5s 定时对账 + 按钮手动触发。
- 两个宿主同时写 `workspace.json` 仍然是**后写覆盖**；本插件靠周期性重新断言来收敛，
  但两个进程同时操作同一个工作区时，仍应保持**单一所有者**（同一条会话不要被两个宿主同时打开）。
- 只补"存在但缺失"的工作区；不删任何东西，也不复活你删过的（靠 `stateFile` 里的删除记忆；该文件被删掉后会重新学习，而推断默认关闭，所以仍不会复活）。
- 归属只按规范路径相等判定；移动过的目录需要重新注册。
- **投递箱只在宿主运行时工作**：桌面应用没开、或插件未挂载时，请求文件会留在
  `inbox/` 里，等下一次挂载时投递（不会丢，也不会重复——`id` 幂等）。
- **投递是文件轮询，不是 RPC**：默认约 1 秒延迟。
- **宿主半代码改动需要重启一次**才会加载；装这一版（含投递箱）需要重启一次桌面。

## License

MIT，署名 heswy —— 见 [LICENSE](LICENSE)。仓库内两个 skill 各自带同文许可证（`skills/dsh2codex/LICENSE`、`codex-skills/codex2dsh/LICENSE`）。
