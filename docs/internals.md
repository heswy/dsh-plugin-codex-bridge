# 内部机制与实测证据

这份文档回答**"为什么这么设计"**。下面每一条都是在本机实测得到的
（DSH `0.2.0-rc.2`、macOS、2026-10-13），不是推测；凡未验证的都会明说。

## 为什么需要这一层：数据只有一份，但列表不会自己更新

| 事实 | 证据 |
|---|---|
| 会话与工作区数据**只有一份**，在 `~/.dsh/` 下共享 | `~/.dsh/sessions/`、`~/.dsh/storages/workspace.json` |
| profile 只隔离**配置 / 插件**，不隔离数据 | `~/.dsh/profiles/desktop/`、`~/.dsh/profiles/web/` 里只有 `cordis.yml`、`cordis.patch.yml`、`package.json`、`node_modules`，**没有任何 storages** |
| 独立 Web 实例建的会话，桌面能打开并**继续写** | 桌面 14:36 重启后对 `session-8734a6fd-…` 加锁、14:37 写入同一条会话日志 |
| 但工作区**列表**不会跟着变 | 工作区注册表只在**空库时**按会话历史引导一次，之后不再重扫；其自身文档写明"外部变更延迟可见 —— 项目只能在下次刷新或重启后反映出来" |
| 两个活着的宿主还会互相覆盖 | 谁最后写领域文件谁生效，外部注册项会被桌面随后的任一次写入抹掉 |

结果：外部建的会话在桌面上显示在**"未分组"**下——而"未分组"正是"会话所属工作区不在工作区列表里"的落点。

## 宿主半怎么对账（只增不改）

每 `intervalMs`（默认 5s）跑一轮：

1. 读共享的 `storages/workspace.json`（当普通文件读，所以看到的是**外部真相**，而不是本进程自己的内存副本），取出所有已登记的工作区路径；
2. （**默认不做**，需把 `includeUngroupedSessions` 打开）再取 `sessionQuery.listSessions()` 的 `header.cwd`，作为"有会话跑过、但没有工作区覆盖"的候选目录；
3. 凡是**在共享文件里存在、但本地活注册表里没有**、且目录仍然存在的 → 调 `ctx.workspaceRegistry.create(path)` 补上。这一步就是全部关键：它既持久化记录，又在 workspace follow 流上发布变更，**已经打开的侧栏因此自己就更新了**；
4. 对**成员为空**的工作区，把 cwd 落在它里面的会话用 `attachSession(sessionId)` 归组（注册表自己的校验会复核 `header.cwd` 是否解析到该路径，不合适的会被拒绝而不是硬塞）。

**永不重命名、永不重排、永不归档、永不删除任何工作区。**

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

## 投递箱为什么必须由锁持有者代投

一条 Session 只有一个写者。桌面窗口打开某条会话时持有它的 `session.lock`，另一个宿主进程
去写就会拿到 `session/writer-held` —— **这是设计，不是 bug**（两个进程同时写会把会话日志写坏）。

所以消息只能由**持有锁的那个进程**投递，而这个插件正好跑在桌面进程里：别的进程把 JSON 丢进
`$DSH_HOME/inbox/`，插件取走并用 `sessionController.prompt(...)` 投进目标会话。

文件层是**读写不对称**的：读（`sessions.json`、会话日志）谁都可以做，冷读安全；写必须走锁的持有者。

## 不打断保证

- `mode` 默认 `queue`：正在跑的轮次不受影响，消息等这一轮结束才被处理——回执里的
  `queuedBehindRunningTurn: true` 就是这个含义；
- `steer` 默认拒绝（想开就在 profile patch 里设 `inbox.allowSteer: true`）；
- 插件从不取消、不中断、不归档、不抢锁；投递失败只写回执，不会反复重试打搅会话。

投递路径的已知边界（实测踩到的两个坑，都已在代码里处理）：

| 现象 | 原因 | 处理 |
|---|---|---|
| `Cannot read properties of undefined (reading 'throwIfAborted')` | `sessionController.prompt` 第一行就调用 `signal.throwIfAborted()`，传 `undefined` 直接抛 | 永远传真实 `AbortController` 的 signal |
| 投递 promise 永不 settle | 中止 signal **不会**让一个不 resolve 的 promise settle | `Promise.race([prompt, deadline])`，超时记 `delivery-timeout` |

## 刻意不做的事

- 不抢锁、不改写锁语义、不替别的宿主写会话日志；
- 不删除、不重命名、不归档工作区；
- 不自动合码、不自动发布、不自动创建 PR；
- 不做无限重试：结果不可确认时**停下**（投递箱写回执；交回通知写 `unknown` 并停止重发）。
