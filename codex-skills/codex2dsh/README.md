# codex2dsh

让主管 Codex 程序化向 DeepSeek Harness（DSH）派发任务，接收开发交回并 review，无需 GUI 自动化。

## 包含什么

- `codex2dsh/SKILL.md`：创建/续作任务、单写者锁、主管回信目标与审查交回约定。
- `scripts/new_task.py`：使用已正常认证的独立 DSH web 宿主注册目录、创建/命名会话、核对目录并queue投递；记录阶段状态。
- `scripts/relay.py`：兼容桌面投递箱客户端，支持list/send/status。
- `scripts/test_new_task.py`：本机模拟HTTP宿主测试，不创建真实DSH任务或调用模型。
- `references/`：分场景协议与操作说明。

## 前提与兼容范围

- Python 3.10+，只使用标准库。
- **已验证 macOS + DSH 0.2.0-rc.2**。脚本使用POSIX `fcntl` 文件锁/文件发布机制；Windows未支持。其他POSIX系统未做端到端验证。
- DSH正常安装及用户自己配置的模型/凭据。独立web profile与桌面配置可能不同，本包不提供模型Key或复制凭据。
- DSH内部RPC会随版本变化，升级后核验参数/返回形状。
- Git任务需要Git；项目自己的worktree、分支、权限与开发规范仍有效。
- **向被桌面持锁的会话投递**，需要另行安装符合 `references/relay-contract.md` 的DSH桥接插件。本包没有宿主插件；只有客户端不会自动开通投递箱。
- **完成后唤醒主管Codex**，需要DSH另行安装 `dsh2codex`，以及支持 `codex queue` 的本机Codex CLI。本包不含接收方Skill。每次任务显式传主管UUID，没有内置接收人。

## 安装

将本包的 `codex2dsh/` 整个目录复制到Codex配置的Skill目录，保留脚本与references；通常是 `${CODEX_HOME:-$HOME/.codex}/skills/`。刷新Skill目录或重新开始会话，以当前应用的加载方式为准。

显式调用 `$codex2dsh`；也可在自然语言中要求创建DSH工作区、派发任务、让原会话修复或查看进度。

本Skill不会因为“安装”自动启动开发；新工作区/新任务需用户明确授权。通知/审查循环不扩展合码、发布或付费权限。

## 运行与验证

以下命令的cwd必须是Skill安装目录（含SKILL.md），不是项目目录：

```sh
python3 scripts/new_task.py --help
python3 scripts/relay.py --help
python3 scripts/test_new_task.py
```

既有会话消息按SKILL的直连→明确writer-held→relay顺序发送；不能把认证失败或超时当作锁冲突。创建任务先读 `references/new-workspace.md`，正常启动自己的loopback宿主并保存私有认证URL文件，显式提供工作区/任务正文/主管UUID/requestId/state。helper不启动或关闭宿主。

新建任务被接受后，承载它的宿主须保持运行直到实际结束。创建/投递结果unknown停止重发，不能换ID或删账本绕过去重。回执accepted只代表已接受。

## 验证范围与限制

已有人工端到端验证涵盖：正常认证、DSH工作区与会话创建、实际文件写入、已有桌面会话relay接收，以及 `codex queue` 向明确目标对话投递并触发回复。新任务helper的机械流程另经模拟测试覆盖创建链路、主管绑定、重复执行不重发和创建结果未知阻止重试。

未验证所有DSH版本、跨平台、桌面工作区列表实时同步，或电脑休眠/应用关闭时立即唤醒。包内不包含个人日志、任务状态、会话历史、通知账本或认证数据；后续本地生成的这些文件也不应提交。

## 许可证

本包采用MIT许可证，见LICENSE。不包含或授予DSH、Codex、桥接插件及其他第三方组件的许可。
