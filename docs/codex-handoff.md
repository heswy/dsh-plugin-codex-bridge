# 给 codex 的交接说明：把消息投进 DSH 会话

> 写给外部驱动（codex / 任何 agent）：说明如何把一条指令投进**已经在桌面窗口里打开**的
> DSH 会话，而不会撞上 `session/writer-held`。
>
> **前置条件**：桌面应用必须正在运行**且已加载投递箱代码**（一次性重启之后即长期有效）。
> 判断方法：`~/.dsh/inbox/sessions.json` 存在且 `count > 0`。文件不存在或为空 = 通道未就绪。

---

## 一、背景（为什么不能直接发）

DSH 的一条 Session 只有一个写者。桌面窗口打开某条会话时会持有它的 `session.lock`；
另一个宿主进程（比如你）去写同一会话，会拿到 `session/writer-held` 并失败。

这不是缺陷，是保护：两个进程同时写会把会话日志写坏。

所以往「桌面已打开的会话」投消息，只能由**持有锁的桌面进程自己**投递。
做法是：你把请求写成文件丢进投递箱，桌面进程取走并用 `sessionController.prompt()`
投进目标会话——**你不碰锁、不碰会话日志、不碰任何凭据**。

## 二、通道

投递箱目录：`~/.dsh/inbox/`（即 `$DSH_HOME/inbox/`）

| 路径 | 作用 |
|---|---|
| `~/.dsh/inbox/<任意名>.json` | 你投入的请求 |
| `~/.dsh/inbox/receipts/<id>.json` | 处理结果（回执） |
| `~/.dsh/inbox/rejected/<id>.json` | 被拒的请求（格式错、要求 steer 等），原样保留 |
| `~/.dsh/inbox/sessions.json` | 宿主发布的会话索引，用来挑 `sessionId` |

## 三、怎么做

### 1. 先拿 sessionId

```sh
node /Users/orange/Documents/deepseek-harness/dsh-plugin-codex-bridge/tools/send.mjs --list
```

输出里 `●` 表示该会话正在跑，`○` 表示空闲；同时给出 `sessionId` 与工作目录。
（也可以直接读 `~/.dsh/inbox/sessions.json`，跳过 `origin: "subagent"` 的条目。）

### 2. 投递并等回执（推荐）

```sh
node /Users/orange/Documents/deepseek-harness/dsh-plugin-codex-bridge/tools/send.mjs \
  --session session-7502f96e-6e67-42dd-9994-ef3d51b4b326 \
  --text "PR #10 的审查意见：……请在本分支修复并补回归。" \
  --from codex
```

退出码：`0` 已投递 / `1` 被拒或投递失败 / `2` 用法错误或等不到回执。

### 2'. 或者自己写文件（等价）

`~/.dsh/inbox/<id>.json`：

```json
{
  "sessionId": "session-7502f96e-6e67-42dd-9994-ef3d51b4b326",
  "text": "PR #10 的审查意见：……",
  "mode": "queue",
  "id": "codex-2026-10-13-1",
  "from": "codex"
}
```

然后轮询 `~/.dsh/inbox/receipts/<id>.json`（约 1 秒内出现）。

## 四、字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 id |
| `text` | 是 | 正文，非空白；上限默认 200 000 字节 |
| `mode` | 否 | **只用 `queue`**（默认）：排队等当前轮次结束。`steer` 会插话到正在跑的轮次，宿主默认拒绝 |
| `id` | 否 | 幂等键，默认取文件名。**同一条指令重试必须复用同一个 id** |
| `from` | 否 | 溯源标签，会写进回执 |

## 五、怎么读回执

| 回执 | 含义 | 你该做什么 |
|---|---|---|
| `ok: true, accepted: true` | 已被会话接受 | 结束；不要重复投 |
| `ok: true, queuedBehindRunningTurn: true` | 目标正在跑一轮，消息**排队等它结束**（没有打断它） | 正常，等即可 |
| `ok: false, code: "session/writer-held"` | 锁不在桌面手里（桌面没开、或没打开这条会话） | **不要重试**，报告给用户 |
| `ok: false, reason: "steer-disabled"` | 你用了 `steer` | 改成 `queue` 重投（换新 id 或复用同一 id 都行） |
| `ok: false, reason: "bad-session-id" / "empty-text" / "text-too-long" / "bad-mode" / "unreadable-request"` | 请求本身有问题 | 修正请求 |
| `ok: false, reason: "delivery-failed"` 且带 `code` | 投递时报错，`code` 是宿主返回的错误码 | 按 `code` 处理 |
| 等不到回执 | 桌面应用没在运行，或插件未加载 | 请求会**留在收件箱**，等桌面下次启动时投递；不要循环重投 |

## 六、硬规则

1. **只用 `mode: "queue"`。永远不要用 `steer`** —— 那会插话到正在跑的轮次，
   宿主默认拒绝；这条限制是为了不打扰正在干活的对话。
2. **`id` 是幂等键**：同一条逻辑指令的所有重试必须复用同一个 `id`，
   否则会在会话里插入重复消息。
3. **不要碰 `session.lock`、不要抢锁、不要为了投递另建开发任务。**
4. 消息进入会话日志时是**用户消息**（`source.kind = "user"`）——界面上看起来就像用户发的。
   这是唯一的用户通道，不要试图伪装成系统消息。
5. **回执只代表"已被接受"，不代表任务完成。** 判断是否完成要看它实际改了什么
   （分支、文件、PR、测试），或者直接问用户。
6. **推荐调用协议**：先按你原来的直连方式发消息；**只有**拿到 `session/writer-held`
   时才改用投递箱。投递箱等不到回执 = 桌面没在运行，报告，不要循环重试。
