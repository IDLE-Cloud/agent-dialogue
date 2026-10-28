# 保持原 TUI 与自动收信：本机验收 2026-10-28

Kimi Code 2.1.1 本机测试通过：原 TUI 从接入到两次来信处理一直打开，两个消息各有一次 `replyTo` 关联回复。中间操作者直接在原 TUI 输入指导，得到正常响应，同时第二个后台收信任务继续运行。对端为受控 CLI；本次不评估自主协作质量，也不替代多机验收。

实现是 Lite `adl wait` 加 Hub scoped inbox 长轮询。等待器运行在 Kimi **原生 Bash 后台任务**中，完成后由 Kimi 自己的 `loop.notify` 继续当前聊天。未修改 Kimi 源码，未启动第二个引擎，未切换到 Web。普通终端运行 helper 本身不能唤醒模型。

## 真实执行证据

测试使用新建的独立项目目录和独立 Kimi session，模型配置为 `DeepSeek/deepseek-flash`。全程 **Always Ask**，只批准五次准确 Bash 命令：原生通知探针、第一次收信、第一次发送、第二次收信、第二次发送。没有启用全局自动批准。

原生 wire 记录中六次 prompt 来源按顺序为：

| turn | 来源 | 行为 |
|---|---|---|
| 0 | user | 原生后台探针，回复 WAIT_ARMED 后结束 |
| 1 | task | 探针完成通知，自动读取结果并响应 |
| 2 | user | 启动第一次 `adl wait --after 0` 后结束 |
| 3 | task | Hub 来信触发；读取完整输出、回复、重新挂接 `--after 3` |
| 4 | user | 原 TUI 中人工指导；回答 HUMAN_KIMI_GUIDANCE_OK |
| 5 | task | 第二次 Hub 来信触发；读取输出、回复、结束且不再挂任务 |

两次 Hub 受理到原生 task prompt 的本机样本分别是 **22 ms / 96 ms**。它们不含模型生成和人工审批耗时，不构成延迟承诺。通知触发处理后，发送命令在原 TUI 等待正常审批，批准后 Hub 接收并由受控对端读取；收件状态一直采用 `tool-read`，没有伪造 native admission 或任务完成状态。

另做了 OpenCode 2.0.20 对照：共享服务拥有的已有聊天在 TUI 打开时接收原生推送并自动回答，之后可在同一 TUI 输入人工指导；8 条证据断言通过。该对照未需要新增 OpenCode runtime，不能替代 Kimi 测试。

## 自动测试与审查

- Node 24.19.0 和 Node 26.10.0：Lite 各 **56/56** 通过，无跳过或失败。
- waiter 专项 **13/13**：真实 Hub 的 scoped 长轮询、无关收件人/room、分页重读、权限失败、断网退避、取消和关闭清理。CLI 集成另验证静默等信与一次输出。
- 独立审查发现并修复旧 Hub 忽略 `waitMs` 时的高频空轮询。修复后空响应请求间隔至少约一秒，正常长轮询不额外等待；追加旧 Hub 兼容和取消回归。最终无阻断发现。
- 独立 tarball 安装、源码目录外 CLI、安装后的 SQLite Hub/API、网页资源、零运行依赖验证通过。准确包快照见对应 JSON。

原生证据、消息/回复 ID、源码 SHA256 和测试快照见 [结构化结果](tui-coexistence-20261028-v1.json)。第一收信进程加载于旧 Hub pacing 修复前；第二进程加载于最终 runtime 写入后。两者使用同一新长轮询 Hub，旧 Hub pacing 另由确定性测试验证。没有把后写的源码 hash 追溯套给第一进程。

## 使用与尚未验证的范围

接入步骤和可直接给 Kimi 的指令见 [KIMI-TUI.md](../packages/lite/docs/KIMI-TUI.md)。首版要求同一聊天一个等待器，收到消息后保存 cursor 并重新挂接；取消、暂停和正常审批沿用 Kimi 规则。退出或切走 session 后需重新检查接入，不自动启动 Kimi。本机测试已关闭自己的 TUI、Hub 和连接进程，保留私有证据；用户原有聊天与共享服务未停止。

本次未部署 Windows/VPS，未实际测试其它 Kimi 版本、退出后恢复或长时间项目协作。Kimi 的审批/暂停调度边界有固定上游源码依据，未冒充为所有场景的真实 UI 验收。Viewer 展示项目消息，完整工具过程仍在原 TUI。
