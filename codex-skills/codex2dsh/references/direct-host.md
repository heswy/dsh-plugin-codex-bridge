# 已验证的直连宿主（按安装版本核对）

已在 macOS、DSH `0.2.0-rc.2` 实测：自带CLI web profile、正常认证HTTP RPC、工作区注册、会话创建/命名、任务投递、历史读取与实际文件写入。该版本的RPC属于宿主内部接口，升级后必须重新核验，不能当作稳定公共API。个人运行日志不随本包发布。

CLI优先通过用户明确路径或 `command -v dsh` 定位，再核对 `--version` / `--help`。macOS应用内曾验证的路径是 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，仅作安装布局例子，不要求所有机器相同。CLI无需打开桌面，使用当前版本支持的web命令、`--no-open`、loopback与空闲端口（可 `--port 0`，再读取实际地址）；不要硬编码端口。已有授权宿主优先复用。

只用本机loopback，正常解析宿主打印的认证URL→请求该URL取得Cookie。认证URL和Cookie仅保留内存或0600临时文件，不输出、入库或提交。不盗取桌面私有连接、签名secret或伪造Cookie。桌面进程的认证接口未直接接通；本流程连接独立Web宿主。

profile的模型/插件不自动与桌面一致：默认web与桌面可能选择不同模型路由，导致web缺少所需凭据。必要时按授权使用临时 `--patch` 加载不含凭据值的模型目录/默认模型元数据；由DSH正常凭据服务解析Key，禁止复制credentials/secrets。不能为了发送消息升级模型、改全局默认值或复制整个profile。缺失路由/配置先报告具体差异。

在0.2.0-rc.2中，向 `POST /api/<namespace>/<method>` 发HTTP JSON，带正常Cookie及匹配Origin：

```json
{"type":"client-request","rpcId":"独立网络调用id","method":"session/prompt","payload":{"args":{"request":{"sessionId":"已确认id","requestId":"同一逻辑指令稳定id","mode":"queue","content":[{"type":"text","text":"用户已授权指令"}],"clientTimeZone":"Asia/Shanghai"}}}}
```

回复为 `{"type":"server-response","rpcId":"…","result":{"ok":true,"value":{"accepted":true}}}` 或 `result.ok:false/error`。直连明确返回 `error.code=session/writer-held`后才启用relay；连接/请求超时不能假定未接受。先查本请求幂等id，不自动换通道或重复派发。

已验证参数：

| 方法 | payload.args |
|---|---|
| session/list | `{ "_request": {} }`；只读，不resume |
| session/prompt | `{ "request": { sessionId,requestId,mode:"queue",content:[{type:"text",text}],clientTimeZone } }` |
| session/page | `{ "request": { address:{kind:"session",sessionId},throughSeq,maxMessages } }`；throughSeq可来自列表projections.asOfSeq |
| workspace/create | `{ "request": { path:"已有目录的绝对路径" } }`；仅用户要求注册时，结果created区分新建/已有 |
| session/create | `{ "request": { workspaceId } }`；仅用户要求创建新任务时 |
| session/rename | `{ "request": { sessionId,title } }`；须用户允许命名 |

调用时用结构化参数/文件，不把正文JSON.stringify后拼到shell。接口随版本变化，边界校验失败时查当前安装包生成的类型/维护方源码，不能反复猜参数。只读取目标会话需要的元数据，别把其他聊天、system prompt或凭据打印出来。

消息已接受后，宿主必须继续运行到其任务完成；不能当作普通诊断立即kill。观测结束再停止**自己**的宿主并清理认证文件，不停止桌面/用户服务。消息投进桌面relay后由桌面承载，不需要新宿主继续运行。独立宿主不能证明桌面列表自动同步；仍不能把新工作区可创建说成桌面可实时看到。
