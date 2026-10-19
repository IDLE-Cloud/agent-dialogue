# Kimi Code 跨机验收（2026-10-19）

固定运行时代码：`b13902f598dfcc0f4c968e752c41537067a8af88`。这是开发分支能力，稳定 v0.2.0 不包含该 adapter。

| 链路 | 检查 | 签名消息 | 关联回复对 | Kimi Bash / Mac 原生工具 |
|---|---:|---:|---:|---:|
| 原生 Windows Kimi Code 2.1.1 ↔ Mac OpenCode | 56/56 | 4 | 2 | 2 / 2 |
| Linux Kimi Code 2.2.0 ↔ Mac OpenCode | 53/53 | 4 | 2 | 2 / 2 |

两套 Kimi 使用各自原有账号及模型配置；本记录验证 harness 和会话路由，不把不同模型当作同一个模型评测。本机 OpenCode 端使用实时目录模型清单确认的零价格模型；不声称 Kimi 使用免费额度或成本为零。

## 验收依据

先为两端独立原生 home 创建测试聊天并明确选择模型。每个聊天接受自己的 owner 指南与预置合成事实，再绑定准确 native session、签名卡片和共同 room。操作者发起一次 Mac→Kimi 和一次 Kimi→Mac 请求；模型通过真实原生工具执行完整的局部排队命令，worker 完成签名 SSH 投递。最终从两端账本的签名父链重建四条消息，逐项关联 native tool→队列 JSON→账本事件→worker 正式消息→准确原生输入及最终回复。

每个远端另执行一次原 ID 重放，以及同 ID 改正文并重新签名、损坏签名、未接受 room、错误 expected-session 四项拒收。核对远端账本、原生 user ID 和输入映射不变，未通过模型文字推断投递或去重。

全量单元测试 **457/457** 与安装包 smoke 通过。原机 Windows 的 adapter/wiring/admission/transport/worker/platform 首轮 57 项中 55 项通过、2 项因 POSIX SSH 测试 fixture 误用 Windows controller executable 而失败；修正后该 transport 文件 10/10 通过，未放宽生产路径检查。Linux 定向案例 41/41。

## 保留的失败与范围

Windows 首次 seed 的 input 已完整持久化，但新 API chat 没有选择模型，原生报 `model.not_configured`。通过官方 profile 接口为这段新测试聊天选择同一个既有模型 alias，随后以单独新 fixture 验收成功；没有重发不确定输入。宽泛认证字符串搜索误匹配上下文的初步判断已校正，以精确 native 错误 code 为准。

验收器也保留过两类错误：未来承诺中提到完成 marker 不能算最终答案；全局消息的本地 replyTo 为空，须读取签名 replyToMessageId。已追加先失败后通过的回归。Mac 对早期 owner 测试限制下的 peer 命令正确拒绝，owner 对原有请求明确授权一次具体回复后完成；这不扩大模型或工具批准模式。

Windows 原始字节 gate 的 v1 为 52/53，失败原因是 Git core.autocrlf=true。最终另做来源证明：30 个实际 CRLF 文件全部精确对应固定 Git LF→CRLF 转换，Git clean hash 与固定 blob 全匹配，其他差异为零；原始 LF byte hash 不匹配这一事实保留。服务器与 Mac 的 30 个 lib/bin 文件则是原始 LF 字节完全匹配。没有为通过验收改写已运行代码的换行。

模型任务结束后，三个通信绑定均 detach，worker 停止；原生聊天、独立 Kimi 服务和既有研究进程保留。三源只读观察另记结果。完整连接、native IDs、正文、私有配置、原始失败及完整 verifier 在 ignored 私有部署目录；公开文件为封闭脱敏投影。

本次为操作者限定命令和合成事实的协议联调，不能外推为自主任务完成质量、任意活跃 TUI 接管、进程退出恢复或上下文因果性证明。配置见 [Kimi 指南](../../docs/KIMI.md)；摘要见 [metrics.json](metrics.json)。

只读三端查看器另通过20项检查及9项真实浏览器交互检查：3个健康来源、2个room，共14条逻辑记录（8条签名交换消息＋6条操作者输入），4对关联回复。REST分页、导出、SSE及未认证拒绝正常；每端5个通信状态文件在观察前后SHA256不变。浏览器核对两房间各7条记录、历史分离状态、回复跳转与投递证据。本阶段0模型调用、0原生服务API调用，不能将查看器日志数等同于模型轮数。

首轮文档提交 d834d25 的 CI：四组 Linux/macOS 通过，Windows 138项中137通过，唯一失败为既有真实节点身份测试的 Windows ACL inspection（约8043ms，与生产8000ms预算吻合）。Kimi adapter、wiring、验收合同和transport全部通过。日志没有暴露底层原因；并发冷启动资源争用是推断。Windows CI 改为逐文件执行以减少争用，保留真实ACL断言及生产8秒失败关闭限制，不跳过测试、不更改运行时代码；最终CI状态以PR checks为准。
