# 桌面投递箱合同

桌面relay依赖用户另行安装的兼容 DSH 桥接插件，本包**只包含客户端**。已验证的维护方实现曾称 `dsh-workspace-sync`，后续称 `dsh-plugin-codex-bridge`；不假定它们在任何固定目录，也不随本包分发宿主代码。使用前读取实际安装版的 `docs/codex-handoff.md` 与实现/发送工具（曾为 `lib/inbox.js`、`tools/send.mjs`），确认符合下列合同；缺少插件时报告桌面会话无法经投递箱接收，不抢锁或新建替代任务。

本包 `scripts/relay.py` 可直接list/send/status，不依赖原生send.mjs路径。默认目录由 `DSH_HOME` 解析为其 `inbox` 子目录，未设置则使用当前用户主目录下 `.dsh/inbox`；可通过 `--dir` 指定维护方确认的实际目录。请求 `<id>.json`：

```json
{"sessionId":"session-example","text":"用户已授权的正文","mode":"queue","id":"codex-example-001","from":"codex"}
```

`id`同时是幂等键和文件名，限制为安全字母/数字/点/下划线/连字符，不含路径或`.`/`..`。原子发布完整JSON，不让宿主读到半文件。默认text上限200000 UTF-8字节。

`receipts/<id>.json`给出ok/accepted/sessionId/mode/from，以及queuedBehindRunningTurn或code/reason/message。`rejected/<id>.json`是被拒请求原件。`sessions.json`给出generatedAt/count/items（含sessionId、cwd、origin、running等），排除subagent。

原生CLI退出码：0已投递，1拒绝/失败，2用法错误/等待超时。helper同样约定0=已接受，1=拒绝/错误，2=未就绪/超时/无回执。退出码2不意味着请求从未投递，检查同id的回执和待处理文件。回执不证明任务完成。

正常流程是直接投递→得到writer-held→桌面relay queue。锁是单写者保护；只有持有锁的宿主能投向其活会话，不能用另一个宿主加载它。不要把“切换到另一个聊天”当作已经释放写锁，之前诊断并未证明这一点。
