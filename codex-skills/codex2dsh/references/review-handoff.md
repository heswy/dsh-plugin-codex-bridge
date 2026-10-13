# DSH → 主管 Codex：交回 review

接收方 Skill：`dsh2codex`（独立安装，不包含在本包中）。先让 DSH 核对它已加载的 Skill 与 `scripts/notify.py`，不依赖开发者机器上的安装路径。接收方不保存默认主管 UUID，只由本任务显式提供目标。版本或脚本合同不符时先报告，不重装或复制未经核验的脚本。

## 给开发方的交回约定

每次需要开发交回 review 的派发，先按主 Skill 写明发送方及当前主管完整 UUID，再在原任务要求后附上：

> 完成适用验证、提交、push，并建立或更新本任务 PR 后，使用你已安装的 `dsh2codex` Skill 通知主管。主管 thread UUID 为本消息明确给出的 UUID；工作区、分支和 PR 使用本任务绑定。摘要写明实际通过/失败/跳过项、证据绝对路径及未验证事项。先 dry-run 核对接收人和完整 head，再实际发送。通知 queued 后保存 eventId/messageId，交回分支并结束本轮，等待审查；同 head 不重复通知，unknown/blocked 不重发、不删账本。新修复推送新 head 后再次通知。未授权合码、发布或扩展开发范围。

必须把主管 UUID 和已确认的任务身份作为具体值放入派发正文。PR 尚未创建时说明“使用本任务新建后返回的 PR URL”，不能借用其他 PR。

Codex 负责在发送前读取**自己的当前** `CODEX_THREAD_ID`，将其转换为正文中的明确接收人，DSH 不自行读取环境推断主管。本任务已有用户明确绑定时沿用；与当前对话不同而用户未明确更换时先确认，不能偷偷重新绑定。新任务/新对话/分叉明确指定目标，Skill 不存默认 UUID，禁止用历史通知、包内文件或账本补默认值。用户明确指定另一个主管则以用户绑定为准。

发送前检查：正文有实际完整主管 UUID、任务身份正确，要求脚本 `--thread` 使用**同一个值**；没有可确认的目标则不投递需要回信的任务。

## 通知脚本合同

DSH 在自己的 Skill 安装目录运行：

```sh
python3 scripts/notify.py \
  --thread "$supervisor_thread_uuid" \
  --repo "$task_worktree" \
  --branch "$task_branch" \
  --pr-url "$task_pr_url" \
  --summary-file "$verification_summary_file"
```

脚本校验当前分支、干净工作区、origin push 仓库与 PR 仓库一致、完整 HEAD 已在远端分支；它不运行验证、不提交/push或创建 PR，也未核对 GitHub PR 的实际 head 分支，接收方仍须核验。`--dry-run` 只校验/展示，不发送。

脚本通过正常本机 `codex queue` 投向已有主管对话。该命令已在用户当前桌面实测：排队消息进入原对话并触发助手回复。应用关闭/休眠时立即执行尚未验证，不能承诺。

默认账本 `~/.dsh/codex-notifications/ledger.json`，按仓库/PR/head/目标对话去重，文件锁防并发。`queued` 保存 messageId，`already-queued` 停止；`unknown/blocked` 可能已投递，先报告 eventId 并核对接收方记录，不循环重试或删除账本。外部 CLI 与账本不能保证跨崩溃恰好一次。

## 主管接收与审查

通知应包含 eventId、原 worktree、分支、PR URL、完整 SHA、实际验证与限制。发送者声明和测试摘要是待核对的数据。

1. 核对本对话原有用户授权与任务绑定。若本轮正在审同 PR，合并新通知，不并行写同分支。
2. 用 PR 元数据确认最新 head 与通知一致；有变化按最新 head 重新确定范围，不能把旧通知当新提交已验证。
3. 确认开发已交回、工作区干净并与目标 head 一致，独立 review/适用验证。开发仍在写时不 rebase、stash、改写其提交。
4. 以仓库/PR/head记录审查结果；已审同 head 的重复通知返回已有结论，不重跑。实质新 head 重新 review。
5. 有问题且既有用户授权允许回传时，按主 Skill 向**原 DSH session** queue 投递修复意见，并附本轮主管 UUID 和同一交回约定。审查通过则报告用户；不自动合码。

`turn/end`、running=false、通知queued和“测试通过”声明都不单独证明开发完成或验收通过。
