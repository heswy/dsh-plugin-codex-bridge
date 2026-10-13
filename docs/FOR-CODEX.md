# 给 Codex 的插件说明（dsh-plugin-codex-bridge）

> 这是一份写给**外部驱动（Codex / 任何 agent）**的说明：我们为「DSH 桌面」做了一个插件，
> 它让外部的你能和桌面上正在跑的会话协作，而**不会踩到写锁**。
>
> 详细投递协议见 [`codex-handoff.md`](./codex-handoff.md)；插件本身的说明见 [`../README.md`](../README.md)。

---

## 一、它解决什么问题

DSH 的一条会话**只有一个写者**：桌面窗口打开某条会话时会持有它的 `session.lock`，
另一个宿主进程（比如你）去写会拿到 `session/writer-held`。这是设计——两个进程同时写会把
会话日志写坏。

所以你需要的不是"抢锁"，而是**请持有锁的那一方代写**。这个插件就跑在桌面宿主进程里
（也就是锁的持有者），它提供：

| 方向 | 通道 | 谁发起 |
|---|---|---|
| **你 → DSH 会话**（写） | `~/.dsh/inbox/` 文件投递箱 | 你丢文件；桌面宿主代投 |
| **DSH → 你**（读） | `~/.dsh/inbox/sessions.json` + 会话日志 | 你自己读，不需要任何锁 |
| **DSH 完成 → 通知你** | `codex queue --thread … --message …` | DSH 侧（当前用 Skill 约定，不靠插件） |

---

## 二、你能用的三件事

### 1. 发现会话（只读）

```sh
node /Users/orange/Documents/deepseek-harness/dsh-plugin-codex-bridge/tools/send.mjs --list
```

输出形如（`●` = 该会话正在跑，`○` = 空闲）：

```
# 80 条会话，索引生成于 10/13/2026, 6:40:00 PM
● session-6018fb61-1a57-41c5-97bf-26fc169c38bb
    /Users/orange/Documents/deepseek-harness/default-workspace
○ session-7502f96e-6e67-42dd-9994-ef3d51b4b326
    /Users/orange/Orange Field/YichunLab Desktop-worktrees/layer-decomposition
```

也可以直接读 `~/.dsh/inbox/sessions.json`（字段：`sessionId` / `cwd` / `running` / `blank` /
`updatedAt`；跳过 `origin: "subagent"` 的条目）。这个文件由桌面宿主每约 10 秒刷新一次。

### 2. 投递指令（写）

```sh
node /Users/orange/Documents/deepseek-harness/dsh-plugin-codex-bridge/tools/send.mjs \
  --session session-7502f96e-6e67-42dd-9994-ef3d51b4b326 \
  --text "PR #10 的审查意见：……请在本分支修复并补回归。" \
  --from codex
```

它会把请求写成 `~/.dsh/inbox/<id>.json`，然后**等回执**并打印：

- 退出码 `0` = 已投递；`1` = 被拒或投递失败；`2` = 用法错误 / 等不到回执。
- 回执 `ok:true, accepted:true` → 会话已接受。
- 回执 `queuedBehindRunningTurn:true` → 目标正在跑一轮，消息**排队等它结束**，没有打断它。
- 回执 `code:"session/writer-held"` → 锁不在桌面手里（桌面没开或没打开这条会话）→ **不要重试**，报告。
- 等不到回执 → 桌面没在运行；请求会留在收件箱，等桌面下次启动时投递。

不想用 CLI 也行，直接写文件（见协议文档），再轮询 `~/.dsh/inbox/receipts/<id>.json`。

### 3. 读进度（只读，不需要锁）

会话日志是**追加的 zstd 帧**，可以只解压尾部：

```
~/.dsh/sessions/--<把路径里的 / 换成 -，空格换成 ~0020>--/<sessionId>/session.v4.jsonl.zstd
```

`zstd` 命令本机有；Node 24 也有 `zlib.zstdDecompressSync`。每个帧独立解压，
所以"只看最新事件"很便宜。事件类型里你能用到的：

| 事件 | 含义 |
|---|---|
| `user/message` | 用户/投递进来的消息（`source.rpcId` 就是你投递时的 `id`） |
| `assistant/message` | 模型的回复（含 tool-call 内容） |
| `tool/call` / `tool/result` | 执行记录 |
| `turn/end` | **一轮结束**（这才是"这一轮做完了"的信号） |

注意：`sessions.json` 里的 `running: true` 只表示"有个活跃回合"，**不等于任务完成**；
一轮里可以有很多 step。判断完成要看 `turn/end`，以及它实际改了什么（分支 / 文件 / PR）。

---

## 三、硬规则

1. **只用 `mode: "queue"`**（默认）。**永远不要用 `steer`** —— 那会插话到正在跑的轮次，宿主默认拒绝。
2. **`id` 是幂等键**：同一条逻辑指令的所有重试必须复用同一个 `id`，否则会在会话里插重复消息。
3. **不要碰 `session.lock`、不要抢锁、不要为了投递另建开发任务。**
4. 消息进入会话日志时是**用户消息**（`source.kind = "user"`）——界面上看起来就像用户发的。
5. **投递回执只证明"指令已收到"，不证明任务完成。** 完成与否看它改了什么。
6. **推荐协议**：先按你原来的直连方式发；**只有**拿到 `session/writer-held` 时才改用投递箱。
7. 桌面可能同时被你**和用户**使用（用户会直接在会话里对话）——所以不要假设"只有你在驱动它"，
   也不要试图独占。

---

## 四、这个插件还有什么（你可能想知道）

除了投递箱，同一份插件还做工作区对账（都是给桌面看的，不影响你）：

- **工作区同步**：别的 DSH 宿主注册的工作区，几秒内出现在桌面侧栏（不用重启）。
- **删除记忆**：用户在桌面删掉的工作区**不会被重新登记回来**。
- **侧栏刷新按钮**：桌面侧栏底部一个刷新图标，手动触发一次对账。

它**不做**的事：不取消 / 不中断 / 不归档 / 不重命名任何会话；不改你的工作区文件；
不碰凭据；除了"代投一条 `queue` 消息"之外不写任何会话。

---

## 五、当前实况（2026-10-13）

| 项 | 值 |
|---|---|
| 插件目录 | `/Users/orange/Documents/deepseek-harness/dsh-plugin-codex-bridge/` |
| 宿主半 | `lib/index.js`（对账 + 路由 + 定时器）、`lib/inbox.js`（投递箱） |
| 客户端半 | `lib/client.js`（侧栏刷新按钮） |
| 装在哪 | `~/.dsh/profiles/desktop/cordis.patch.yml` → 行 id `workspace-sync` |
| 投递箱 | `~/.dsh/inbox/`（`receipts/` 回执、`rejected/` 被拒、`sessions.json` 索引） |
| 删除记忆 | `~/.dsh/workspace-sync/state.json` |
| 你的成功投递 | `codex-pr10-r2-fix-…`（18:01:39）、`codex-pr10-r3-fix-…`（18:38:52），均 `ok:true` |
| 前提 | **桌面应用必须在运行**（插件在它的进程里）；宿主半改代码要重启，改配置/加 Skill 不用 |

---

## 六、反方向：DSH 完成后通知你

DSH 侧通过你的 CLI 入队：

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
  queue --thread <你的 thread UUID> --message "<交接说明>"
```

目前这是**由 Skill 约定的动作**（什么时候发、填什么占位符写在 Skill 里），
不是插件自动触发的——因为是否"完成"、要不要通知，取决于用户与开发会话的实际进展。
`queue` 回执只代表**已排队**，不代表 review 通过。
