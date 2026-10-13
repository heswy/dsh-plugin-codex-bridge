<div align="center">

# dsh-plugin-codex-bridge

**让 Codex 与 DSH 开发会话协作**

工作区实时同步 · 双向投递 · 一次性交回<br>
不重启桌面 · 不抢会话写锁 · 不接管 Git

[![ci](https://github.com/heswy/dsh-plugin-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/heswy/dsh-plugin-codex-bridge/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-3DA639?style=flat-square)](LICENSE)
[![tests: 65 assertions](https://img.shields.io/badge/tests-66%20assertions-brightgreen?style=flat-square)](#测试与-ci)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](#兼容性)
[![DSH: 0.2.0-rc.2](https://img.shields.io/badge/DSH-0.2.0--rc.2-4B6EF5?style=flat-square)](#兼容性)
[![python: 3.8+ / 3.10+](https://img.shields.io/badge/python-3.8%2B%20%7C%203.10%2B-3776AB?style=flat-square)](#兼容性)
[![platform: macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey?style=flat-square)](#兼容性)
[![PRs: welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](#开发与贡献)

<sub>Bridge Codex and DeepSeek Harness (DSH) dev sessions — live workspace sync, a
lock-respecting message inbox, and a one-shot handoff back to the supervisor.<br>
No restart · no lock stealing · no Git takeover · zero npm dependencies.</sub>

</div>

---

## 它解决什么问题

Codex（或任何外部驱动）可以通过本地 RPC 驱动一个**独立的 DSH 宿主**：建 worktree、建分支、建会话、派发开发任务。
这时你会撞上三堵墙——它们都来自 DSH 的一条硬约束：**同一个 `~/.dsh/` 数据目录，一条会话只有一个写者。**

| 你遇到的问题 | 本项目的答案 |
|---|---|
| 外部建的会话在工作区列表里显示成"**未分组**"，刷新桌面也不出现 | **工作区同步**：插件把共享文件里"已登记但本地没有"的工作区注册进来，已打开的侧栏自己就更新了 |
| 想让 Codex 往**已经打开的**会话里说话，却拿到 `session/writer-held` | **文件投递箱**：请求写进 `~/.dsh/inbox/`，由**锁的持有者**（桌面进程）代投——绕开冲突，而不是抢锁 |
| 会话干完活了，主管 Codex 不知道 | **交回通知**：`skills/dsh2codex` 校验"真的推上去了"，再经 `codex queue` **恰好一次**地发回主管对话 |

```
   Codex ──①──► 共享文件层 ~/.dsh/ ──②──► 桌面 DSH 进程（持锁） ──► 你
     ▲                  ▲                        │
     │                  └─── ④ 投递请求 / 回执 ─────┘
     └─── ③ 交回通知（skills/dsh2codex → codex queue）

   ① Codex 建 worktree / 工作区 / 会话（直连 RPC）
   ② 插件对账：共享文件里"存在、但桌面注册表里没有"的工作区 → 注册（只增不改）
   ③ 开发会话完成并 push → dsh2codex 把交接通知发给 Codex
   ④ Codex 要往被桌面持锁的会话说话 → 写 inbox/*.json，插件取件代投
```

## 三个能力

| | 形态 | 方向 | 一句话 |
|---|---|---|---|
| **工作区同步** | 插件（宿主半 + 侧栏按钮） | 外部 → 桌面 | 只增不改、删除有记忆、不需要重启 |
| **投递箱** | 插件（同一进程内取件） | Codex → DSH | 由会话锁持有者代投，`queue` 语义，不打断正在跑的轮次 |
| **交回通知** | Skill（纯 shell + 文件） | DSH → Codex | 只读校验真实 Git 状态，事件 ID 幂等，结果不可确认就停 |

## 快速开始

**① 装插件** —— 设置 → 插件 → 添加插件，三种填法都行：

| 填什么 | 例子 |
|---|---|
| GitHub 仓库地址 | `https://github.com/heswy/dsh-plugin-codex-bridge` |
| 包名（已发布到 npm 时） | `dsh-plugin-codex-bridge` |
| 本地目录路径 | `/绝对路径/dsh-plugin-codex-bridge` |

**② 装两个 skill**（双向协作需要；只用单向可跳过对应的那个）：

```sh
cp -R skills/dsh2codex         ~/.dsh/skills/     # DSH 侧：交回主管 Codex
cp -R codex-skills/codex2dsh   ~/.codex/skills/   # Codex 侧：派活、回意见、建工作区
```

**③ 30 秒自验**（不用看日志）：

1. 插件页出现 `dsh-plugin-codex-bridge`，状态启用；
2. 侧栏底部（设置旁）出现**刷新图标**；
3. `~/.dsh/inbox/sessions.json` 每隔约 10 秒刷新，`count` 是当前可见会话数。

## 仓库结构

| 路径 | 是什么 | 装到哪 |
|---|---|---|
| 仓库根 | DSH **插件**：工作区同步 + 文件投递箱 | 设置 → 插件 → 添加插件 |
| [`skills/dsh2codex/`](skills/dsh2codex/) | DSH 侧 **skill**：交回通知（正向） | `~/.dsh/skills/dsh2codex/` |
| [`codex-skills/codex2dsh/`](codex-skills/codex2dsh/) | Codex 侧 **skill**：派活 / 回意见 / 建工作区（反向） | `~/.codex/skills/codex2dsh/` |
| [`docs/codex-handoff.md`](docs/codex-handoff.md) | 交接协议与投递箱契约 | — |
| [`docs/FOR-CODEX.md`](docs/FOR-CODEX.md) | 写给 Codex 的接入说明 | — |
| [`docs/internals.md`](docs/internals.md) | 内部机制与实测证据（为什么这么设计） | — |

三个部件可以独立分发：插件零依赖、两个 skill 各自带同文 MIT 许可证与自测。

## 安装

本仓库根就是一个标准 DSH **组合包**：`package.json` 声明了 `dsh.bundle.patch` 与
`dsh.client.platform`，因此 DSH 自带的插件管理器可以直接安装它。装完会出现在插件列表里，
可停用 / 启用 / 卸载；卸载会从 `dsh.profile.bundles` 移除并 `pnpm remove`。

<details>
<summary>开发模式：手工挂载（不经过插件管理器）</summary>

在 profile 的 `cordis.patch.yml` 里 insert 一行，`name` 指向 `lib/index.js` 的绝对路径：

```yaml
- insert:
    - id: workspace-sync
      name: '/绝对路径/dsh-plugin-codex-bridge/lib/index.js'
```

**不要与"添加插件"装的那份同时使用**，否则同一条 `workspace-sync` 行会被挂两次。
</details>

## 配置

按机器覆写配置时，写在 **profile 自己的** `cordis.patch.yml` 里（它在所有 bundle 层之后生效）：

```yaml
- id: workspace-sync
  config:
    intervalMs: 15000
    inbox:
      allowSteer: false
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `routePath` | `/api/workspace-sync` | 客户端按钮用的路由，必须以 `/api/` 开头 |
| `registryFile` | `<DSH_HOME>/storages/workspace.json` | 共享工作区文件 |
| `autoSync` | `true` | 是否定时对账 |
| `intervalMs` | `5000` | 对账周期（1000–600000） |
| `includeUngroupedSessions` | **`false`** | 是否把"有会话跑过但无工作区"的目录也注册。默认关闭：删除工作区不删文件夹与会话，打开这条推断会让删掉的工作区复活 |
| `stateFile` | `<DSH_HOME>/workspace-sync/state.json` | 删除记忆（`lastSeen` + `tombstones`） |
| `attachSessions` | `true` | 给空成员工作区归组会话 |
| `excludeDshHome` | `true` | 不注册 `DSH_HOME` 下的内部目录 |
| `maxAddsPerPass` | `20` | 单轮最多新增几个（防刷屏） |
| `inbox.enabled` | `true` | 是否启用投递箱 |
| `inbox.dir` | `<DSH_HOME>/inbox` | 投递箱目录 |
| `inbox.intervalMs` | `1000` | 取件周期 |
| `inbox.allowSteer` | `false` | 是否允许 `steer`（插话到正在跑的轮次） |
| `inbox.maxTextBytes` | `200000` | 单条正文上限 |
| `inbox.indexIntervalMs` | `10000` | 会话索引刷新周期 |
| `verbose` | `false` | 每轮都打日志，而不只在有变更时 |

## 接口与 CLI

```
GET  /api/workspace-sync              # 状态：配置 + 最近一次对账结果 + 能力自检
POST /api/workspace-sync?action=sync  # 立刻对账一次，返回本次结果
GET  /api/workspace-sync?action=doctor# 现跑一次能力自检
```

侧栏底部有一个刷新按钮（槽位 `sidebar.footer.action`，id `workspace-sync`）：点一下立刻对账，
悬停提示会说明结果（新增 N 个 / 无需添加 / 失败原因）。

发送端 CLI（外部进程用，只写文件、不碰会话、不碰锁、不碰 profile）：

```sh
node tools/send.mjs --list
node tools/send.mjs --session session-7502f96e-… --text "请修复 PR #10 的审查意见" --from codex
```

退出码：`0` 已投递 / `1` 被拒或投递失败 / `2` 用法错误或等不到回执。`--id` 可幂等重投。

## 投递箱契约

`$DSH_HOME/inbox/<任意名>.json`：

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
| `text` | 是 | 正文，非空白，≤ `inbox.maxTextBytes` |
| `mode` | 否 | `queue`（默认）排队等当前轮次结束；`steer` 中途插话，**默认被拒** |
| `id` | 否 | 幂等键，默认取文件名。同 id 重投不会重复插消息 |
| `from` | 否 | 写进回执便于溯源 |

| 结果文件 | 内容 |
|---|---|
| `inbox/receipts/<id>.json` | `ok` / `accepted` / `mode` / `targetRunning` / `queuedBehindRunningTurn` / 失败时的 `code` |
| `inbox/rejected/<id>.json` | 格式错或被拒的请求，原样保留 |
| `inbox/sessions.json` | 宿主发布的会话索引（`sessionId` / `cwd` / `running`），发送端据此挑目标 |

完整协议见 [`docs/codex-handoff.md`](docs/codex-handoff.md)。

## 安全与边界

**核心原则是读写不对称**：读（会话索引、会话日志）谁都可以、冷读安全；**写必须走锁的持有者**。
本插件不改变这条语义，只是把它变成可用的通道。

| 情况 | 行为 |
|---|---|
| 目标会话正在跑轮次 | `queue`：等这一轮结束（回执 `queuedBehindRunningTurn: true`），**不打断** |
| 请求 `steer` | 默认拒绝，想开需显式配置 |
| 会话 id 不存在 | 回执 `code/session/not-found`，不重试打搅 |
| 桌面应用没开 / 插件未挂载 | 请求留在 `inbox/`，下次挂载时投递；`id` 幂等，不会重复 |
| 用户删了工作区 | 不会因对账复活（删除记忆，见 [internals](docs/internals.md#删除会被记住为什么需要这一层)） |
| DSH 升级改了内部契约 | 能力自检（doctor）在日志里明确报错，结果也挂在状态接口上 |
| 交回通知结果不可确认 | skill 记 `unknown` 并**停止**，交人核对；不删账本绕过去重 |

**它永不**：抢锁 / 改写锁语义 / 删除或重命名工作区 / 自动合码 / 自动发布 / 无限重试。

## 测试与 CI

```sh
node tests/harness.mjs        # 17 条：工作区对账 + 删除记忆 + 能力自检
node tests/inbox.mjs          # 12 条：投递箱（steer 拒绝、并发取件、各类拒绝路径）
node tests/relay-e2e.mjs      #  5 条：真发送端 CLI ↔ 真投递箱
node tests/dry-run.mjs        # 只读预演：本机现在会新增哪些工作区

python3 skills/dsh2codex/tests/test_notify.py              # 32 项，完全离线
python3 codex-skills/codex2dsh/scripts/test_new_task.py    # 模拟宿主，不碰真会话
```

全部测试**不需要网络、不需要真的 DSH 或 Codex**：插件测试把 `DSH_HOME` 指向临时目录，
skill 测试用假 CLI + `git ls-remote` shim。CI 在 **Linux 与 macOS** 双平台跑
（[workflow](.github/workflows/ci.yml)）。

## 兼容性

| 组件 | 要求 | 验证状态 |
|---|---|---|
| 插件 | DSH `0.2.0-rc.2`；Node 20+；**零 npm 依赖** | macOS 实测；Linux 由 CI 覆盖 |
| `skills/dsh2codex` | Python 3.8+、`git`、能 `queue` 的 Codex CLI | 32 项离线测试 + 真机 `--probe` |
| `codex-skills/codex2dsh` | Python 3.10+、DSH CLI/宿主 | 自带模拟宿主测试 |
| 平台 | macOS（实测）、Linux（CI）；**Windows 未验证** | — |
| 代码托管 | 交回校验与 PR 匹配只支持 `github.com` | — |

本包**刻意不声明** `@deepseek-ai/dsh-*` 的 peerDependencies——这样任何 DSH 版本都能装。
代价是拿不到版本闸门，所以插件每轮对账都会跑一次**能力自检**（服务形状、共享域文件、可写目录、
工作区实体形状），DSH 内部契约漂移时明确报错而不是静默失效。

## FAQ

<details>
<summary><b>为什么不直接加一个"外部写入"接口？</b></summary>

因为会话日志是追加写的，两个进程同时写会写坏。写锁是保护而不是障碍，所以本项目的做法是
**把请求交给锁的持有者**，而不是绕过检查。
</details>

<details>
<summary><b>为什么两个 skill 要单独装？</b></summary>

skill 是给各自的 agent 读的：`dsh2codex` 装进 DSH 的 skill 目录、`codex2dsh` 装进 Codex 的
skill 目录。插件管不了对方的技能目录，所以它们是三个可独立分发的部件。
</details>

<details>
<summary><b>插件会不会在我干活的时候插话？</b></summary>

不会。投递默认 `queue`（等当前轮次结束），`steer` 默认拒绝；插件从不取消、不中断、不抢锁。
</details>

<details>
<summary><b>我的工作区删了又被刷新出来过，这版还会吗？</b></summary>

不会。根因是"从会话目录反推工作区"这条推断会把删掉的工作区登记回来；本版**默认关闭该推断**，
并额外持久化"删除记忆"。详见 [internals](docs/internals.md#删除会被记住为什么需要这一层)。
</details>

## 已知限制

- 改 `lib/index.js`（宿主半**代码**）后需要重启桌面或重装该组合包才生效；改**配置**与客户端半会热生效。
- 不是实时推送：靠 5s 轮询 + 手动刷新按钮。
- 两个宿主同时写 `workspace.json` 仍是**后写覆盖**；本插件靠周期性重新断言收敛，但同一条会话仍应保持**单一所有者**。
- 投递是**文件轮询**（默认约 1 秒延迟），不是 RPC。
- 工作区归属只按规范路径相等判定；目录被移动过需要重新注册。
- 只支持 GitHub 工作流；`codex queue` 的可用性随 Codex 版本变化（用 `--probe` 确认）。

## 开发与贡献

```sh
git clone https://github.com/heswy/dsh-plugin-codex-bridge.git
cd dsh-plugin-codex-bridge
node tests/harness.mjs && node tests/inbox.mjs && node tests/relay-e2e.mjs
python3 skills/dsh2codex/tests/test_notify.py
```

改代码前请跑一遍上面的测试；改动请保持三条设计原则——**显式**（不猜目标）、
**幂等**（同一次动作只发生一次）、**可审计**（账本与回执写清楚发生了什么）。
欢迎 [Issue](https://github.com/heswy/dsh-plugin-codex-bridge/issues) 与 PR。

> 注意：仓库里的两个 skill 是**源头**；你机器上 `~/.dsh/skills/`、`~/.codex/skills/` 里的是副本，
> 改动要同时考虑是否同步到运行位置。

## License

MIT，署名 **heswy** —— 见 [LICENSE](LICENSE)。三份许可证同文：
根目录、[`skills/dsh2codex/LICENSE`](skills/dsh2codex/LICENSE)、[`codex-skills/codex2dsh/LICENSE`](codex-skills/codex2dsh/LICENSE)。
