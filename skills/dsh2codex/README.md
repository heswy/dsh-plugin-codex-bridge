# dsh2codex

一个 DSH **Skill**：开发会话完成并推送后，把「已推送的 PR + 验证摘要」经 `codex queue` **恰好一次**地交回主管 Codex 对话。

它是 [Codex ↔ DSH 协作](https://github.com/heswy/dsh-plugin-codex-bridge)里的**正向通道**：
DSH 干完活 → 通知 Codex review。反向通道（Codex 派活/回意见给 DSH）由那个插件提供。

## 为什么需要它

开发会话结束时，人容易漏报、重报、或者把没验证的东西当成已完成交出去。这个技能把「交回」变成一个有**校验、幂等、可审计**的动作：

| 保障 | 怎么做到 |
|---|---|
| 只交**真实存在**的成果 | 只读 git 校验：分支名合法、当前分支一致、工作区干净、origin push 仓库与 PR 同仓、**当前完整 head 确实在远端任务分支上** |
| 不重复打扰 | 事件 ID 由 `(仓库, PR 号, head, 主管 thread)` 决定；账本 + 文件锁，同一次交回永远不会发第二次 |
| 不确定就停 | 只认 CLI 明确回执 `Queued message <id> for thread <id>`；超时/异常/不认识输出 → 记 `unknown` 并**停止**，交由人核对，不删账本绕过去重 |
| 不越权 | 不提交、不 push、不建 PR、不合码、不发布；通知只是通知 |
| 不用错工具 | Codex CLI **自动探测并逐个验活**（见下），因为指向"另一个 daemon"比指向"没有"更危险 |

## 安装

Skill 目录就是它的安装单位，拷进任一 DSH 会扫描的 skill 根目录即可（用户级 `~/.dsh/skills/`，或项目级 `<项目>/.dsh/skills/`）：

```sh
git clone https://github.com/heswy/dsh2codex.git ~/.dsh/skills/dsh2codex
```

也可直接把 `dsh2codex/` 整个目录拷到 `~/.dsh/skills/` 下。要求：

- Python 3.8+（只用标准库）
- `git`
- Codex CLI（能 `queue --thread --message`）—— macOS 上随 ChatGPT 桌面版自带

## 用法

先看它会用哪个 CLI（**只读，不发通知**）：

```sh
python3 scripts/notify.py --probe
```

```json
{ "status": "probe", "cli": "/Applications/ChatGPT.app/…/codex",
  "version": "codex-cli 0.162.0-alpha.17.2", "supportsQueue": true, "candidates": [ … ] }
```

预演（打印将要发送的正文，不投递、不写账本）：

```sh
python3 scripts/notify.py --dry-run \
  --thread '<主管对话 UUID>' \
  --repo '<worktree 绝对路径>' \
  --branch '<原 PR 分支>' \
  --pr-url 'https://github.com/<owner>/<repo>/pull/<n>' \
  --summary-file /abs/path/summary.md
```

正式发送：去掉 `--dry-run`。

**`--thread` 必须每次显式给出**，来自本次用户指令或明确的任务绑定。本技能不保存、不内置、不推断任何主管对话：不要用 DSH 的 sessionId 或工作区名代替，不要沿用历史 UUID。

## Codex CLI 的选择顺序

`--codex-bin` → `DSH2CODEX_BIN` → `CODEX_BIN` → `PATH` 上的 `codex` → `/Applications/ChatGPT.app/…` → `~/Applications/ChatGPT.app/…`

每个候选都要能通过 `queue --help` 且输出里含 `--thread` 与 `--message` 才会被采用；显式指定（`--codex-bin`）时绝不静默换成别的。全都不行就明确报错并列出尝试过的路径。

## 退出码与状态

| status | 退出码 | 含义 | 该做什么 |
|---|---|---|---|
| `dry-run` | 0 | 只预演 | — |
| `queued` | 0 | CLI 确认已排队（保留 messageId） | 交回分支，等 review；**不等于**对方已读或通过 |
| `already-queued` | 0 | 同一 head 已通知过 | 停止，不要重发 |
| `blocked` | 2 | 上一次同事件没发成功，账本已存在 | 停：报 eventId 与账本状态，由人核对 |
| `unknown` | 2 | 超时/异常/输出不认识，**可能已投递** | 停：核对主管历史后人工处理，不删账本绕过去重 |

前置校验失败统一退出 **1**，并在 stderr 说明是脏工作区、head 未推送、还是仓库不匹配——修掉真实问题再重试。

## 与 DSH 插件的关系

- **本技能（正向）**：DSH → Codex，走 `codex queue`。纯 shell + 文件，**不需要插件、不需要重启**。
- **配套插件 `dsh-plugin-codex-bridge`（反向）**：Codex → DSH。桌面进程持有会话写锁，`session/writer-held` 是设计使然，所以由**锁的持有者**代为投递（`~/.dsh/inbox/`）。工作区同步也在那个插件里。

两边都刻意保持"显式、可审计、幂等"：不偷锁、不自动合码、不无限循环。

## 开发

```sh
python3 tests/test_notify.py
```

测试**完全离线**：`git ls-remote` 由一个放在 PATH 最前面的 shim 提供，Codex CLI 是记录调用的桩，账本写在临时目录。覆盖探测、预演、幂等、六种前置校验、`unknown`→`blocked` 不重发、以及"PATH 上的 codex 不支持 queue 时会继续找下一个 / 显式指定时绝不回退"。

## 已知限制

- **只支持 GitHub**：PR URL 与 origin 都按 `github.com` 校验。
- **UI 依赖**：需要 Codex 侧存在 `queue` 子命令（版本相关，用 `--probe` 确认）。
- **恰好一次是有边界的**：外部 CLI + 本地账本无法跨崩溃保证语义上的"恰好一次"；不确定的状态一律停止重发并交人处理。
- **不保证即时**：应用关闭或机器休眠时不会立即执行。
- `~/.dsh/codex-notifications/` 存账本（`ledger.json` + `ledger.lock`），不会提交到 Git；用 `--ledger-dir` 可改。

## License

MIT，见 [LICENSE](LICENSE)。
