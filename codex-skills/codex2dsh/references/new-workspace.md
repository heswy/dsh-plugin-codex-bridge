# 新建 DSH 工作区与开发会话

读取本文件时一并读 [直连宿主](direct-host.md)，按当前安装版核验 CLI、认证及 RPC 形状。此流程已在 DSH 0.2.0-rc.2 注册独立目录、创建会话、派发并实际写文件成功；不保证桌面列表即时同步。

## 先确定授权与目录

仅在用户明确要求新建 DSH 工作区/任务时执行。建立 Codex Git worktree/分支不等于授权自动派发开发；项目分工仍优先。不为绕过已有会话锁建替代任务。

- 用户指定目录时使用其绝对路径；Git 任务先依项目规范准备工作区/指南，核对分支、干净状态与单一负责人。不要修改旧线上仓库。
- 用户授权新建普通目录时先创建真实文件夹；workspace/create 只注册已存在目录，不自动初始化 Git。
- 查会话列表确认是否已有原开发任务。续作回原会话；新建任务已授权且存在同目录会话时，可复用工作区注册但不要替换/接管旧会话。
- 读取 Codex 自己当前主管 UUID，明确写入新任务绑定。准备非秘密 UTF-8 任务正文：实际指南绝对路径、修改范围、验收/验证、Git负责人、交回条件、禁止合码/发布等项目限制。需要PR交回时按 [交回约定](review-handoff.md) 要求使用 `dsh2codex`；非Git写作测试无需虚构PR交回。

## 准备正常认证的宿主

优先复用当前已授权且可正常认证的独立宿主。桌面私有端口不能作为已授权连接，禁止拿签名secret伪造认证。

没有可用宿主时，只启动自己的 CLI web：loopback、`--no-open`、经检查空闲的端口（可用 `--port 0` 并读取实际打印地址），标准输出/错误写入0700临时目录中的0600私有日志。按 [直连说明](direct-host.md) 从日志解析正常打印的认证URL，写0600 `auth-url.txt`，不要将token打印到工具输出/提交。认证只用于本机宿主，Cookie只留helper内存。

启动前核对该宿主的模型/插件路由与用户选用开发Agent一致：独立web profile与桌面可能不同，已有实验显示默认web缺Key。必要时使用用户已授权的无凭据元数据临时patch；不要复制Key或改全局默认模型。CLI版本/路由/认证不成立时先报告，不能创建会话后冒称可正常开发。

将自己的宿主PID、端口、启动参数（不含token）、工作目录、私有日志位置记录在任务观察信息。派发被接受后**必须让承载任务的宿主继续运行**；不把finally结束脚本当作关闭宿主的理由。任务完成再关自己的进程；未完成转交时保留宿主与可续接观察信息，不停止桌面或用户服务。

## 原子阶段记录与创建脚本

脚本 `scripts/new_task.py` 对已正常启动的宿主执行：

1. workspace/create 注册已有目录，保存workspaceId和created标记；created:false表示已存在注册，不证明旧会话可接管。
2. session/create 新建一条任务，立即保存sessionId。
3. session/rename 设置用户授权的任务标题。
4. session/list 核对新sessionId/cwd，排除subagent。
5. session/prompt 以稳定requestId、queue派发正文，自动在前面加入明确主管UUID；保存接受回执。

```sh
python3 scripts/new_task.py \
  --auth-url-file "$private_auth_url_file" \
  --workspace "$authorized_workspace" \
  --title "$authorized_task_title" \
  --text-file "$task_prompt_file" \
  --supervisor-thread "$supervisor_thread_uuid" \
  --request-id "$stable_request_id" \
  --state-file "$private_task_state_file" \
  --branch "$expected_git_branch"
```

普通非Git目录省略--branch。所有值来自本次已确认任务；不能执行模板占位符或复用其他任务的state。状态文件放Git工作区外0700私有目录，原子0600写入，包含任务身份、文本hash、各阶段ID和回执，不包含token/Cookie/Key。只创建/命名会话且不派发或仅注册目录时，不使用此“一次完整派发”helper，按直连表执行用户授权的对应RPC并保存结果。

同一逻辑任务重跑须复用相同state、正文、requestId、接收人。已完成阶段不会重建，accepted返回already-accepted。每次创建/投递前先记pending；超时、进程退出或未解析响应会成为unknown/pending，**停止重试**，根据workspaceId/sessionId和历史核对事实后人工协调，不能删state/换id重新create。明确rejected也保存并停止；writer-held仅对同一已创建session按主Skill回退relay，不再创建会话。

脚本从不启动/关闭宿主、不提交/推送Git、不建立Codex对话、不改DSH配置或凭据。它验证回执，不保证任务最终成功或桌面显示。

## 观察、交回与验收

- 用session/list取得目标projections.asOfSeq，再session/page只读目标记录；记录在record.event，读取assistant/message中type:text、工具实际结果及turn/end。独立宿主running可能与桌面不一致，以拥有者发布索引、最新事件和产物交叉核对，不能凭running:false判完成。
- turn/end区分completed/error/其他结束；历史旧轮完成不代表新派发完成。accepted不是完成。
- 独立核对实际文件/分支/提交/PR与验证结果。PR开发交回通知应发明确主管UUID，经dsh2codex去重后主管review；发现问题按已授权范围交回原session。
- 结束报告工作区路径、workspaceId、新sessionId/标题、主管UUID、requestId、接受/执行状态和宿主归属。不展示认证值。桌面是否可见单独描述已观察事实。

脚本机械行为使用本机模拟HTTP宿主验证，不为验证Skill自动创建真实DSH开发会话；真实互通能力的既有证据见direct-host引用的记录。

机械验证命令：`python3 scripts/test_new_task.py`（仅模拟HTTP宿主/临时目录，无真实DSH或模型请求）。
