# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

发布记录与比较链接见 [Releases](https://github.com/heswy/dsh-plugin-codex-bridge/releases)。

## [Unreleased]

暂无。

## [0.1.0] - 2026-10-14

首个版本：把 DSH 之间、以及 DSH 与 Codex 之间的协作链路做成一个可安装、可离线验证的插件。

### 新增

- DSH 插件本体：把其他 DSH 进程注册的工作区同步进正在运行的桌面窗口，包含工作区对账、删除记忆（避免已删除的工作区被会话目录重新注册）与会话挂载。
- 文件投递箱：外部驱动（Codex 等）向桌面持有的会话投递消息，不抢会话写锁、不需要重启；`steer` 默认关闭，需显式开启才会打断进行中的回合。
- 发送端 CLI `tools/send.mjs`：`--list` 查看宿主发布的会话索引，其余参数按投递箱协议投递并等待回执。
- 双向 skill：DSH 侧 `skills/dsh2codex`（交回通知与状态处理）、Codex 侧 `codex-skills/codex2dsh`（任务派发与审查反馈）。
- 离线测试套件与 CI：4 个 Node 测试（包契约、工作区对账、投递箱、端到端中继）与 2 个 Python 测试，在 ubuntu/macos 上执行。

### 修复

- 客户端半注册的注册 id 必须等于包名，否则每次冷启动都会出现 duplicate registration。
- `dsh2codex` 在 PATH 上第一个 `codex` 不可用时会继续查找下一个候选，而不是直接失败；测试也不再可能触到真实 CLI。

### 文档

- README 重写为项目门面（中文主文档 + 完整英文版），深入内容移入 `docs/`：Codex 接入说明、投递箱协议、内部机制。

### 打包与许可

- 统一许可证为 MIT（heswy），plugin 与两个 skill 分别附带同文许可证。
- 分发包纳入 `skills/` 与 `codex-skills/`，使安装后的包自洽。

### 已知边界

- 插件依赖 DSH 内部服务契约，运行时 `doctor` 检查并报告漂移；没有版本闸门，不代表兼容所有 DSH 版本。
- 已用 DSH `0.2.0-rc.2` 与 Node.js 20+ 验证；完整双向协作另需 Python 3.10+、Git，以及支持 `queue --thread --message` 的 Codex CLI。

[Unreleased]: https://github.com/heswy/dsh-plugin-codex-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/heswy/dsh-plugin-codex-bridge/releases/tag/v0.1.0
