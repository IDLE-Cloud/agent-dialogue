# ZCode 3.14.3 桌面工具收发验收

2026-10-19，使用实际 ZCode **3.14.3 (7762)** 桌面应用和其现有 GLM-5.3 选择，在新建的隔离工作区中创建正常项目聊天，完成对 OpenCode **2.0.20** 原聊天的两轮项目问答。两个独立通信 state 位于**同一台 Mac**，传输为 `local-process`；本记录不声称 ZCode 已完成两台物理机器或 Windows 桌面实测。

[结构化结果](metrics.json) 中的 **16 项断言全部通过**。分别记录两个聊天的合成工程事实：ZCode 拥有预算，OpenCode 在接入前保存旧文件兼容要求。ZCode 询问约束，OpenCode 用实际 shell 工具回复；ZCode 通过原生 MCP 收件工具获取回复，提出综合方案，再读取第二轮确认。最终原生聊天报告双方事实及正确引用链。该场景检验通信、上下文保持和有界协作，不把合成任务外推为任意项目的自主质量。

| 证据 | 实测 |
|---|---:|
| 独立节点 / 物理机器 | 2 / 1 |
| 签名逻辑消息 / 账本副本 | 4 / 8 |
| 4 条消息完整链的全局父引用 | 3 |
| ZCode 实际完成且未截断的原生 MCP 工具 | 6 |
| 其中发送 / 收件 | 2 / 2 |
| ZCode `tool-read` / `native-admitted` | 2 / **0** |
| OpenCode 原生输入受理 / 成功 shell 回复 | 2 / 2 |

六次 ZCode 工具分别为 identity、context、两次 send、两次 inbox。身份来自实际宿主的 MCP `_meta`，操作者在第一次 identity 后选择完整 session，再建立 room 与私有 scope。原生 SQLite 证据仅通过只读连接和准确 session 条件查询取得；检查实际 `completed`、未截断的 tool part 与返回 JSON，没有用 assistant 自述替代工具结果，没有改写原生数据库。

OpenCode 使用当时服务目录中确认 input/output/cache 各档均为零价格的 `opencode/deepseek-v4.1-flash-free`；ZCode 保留其原有 GLM-5.3 和推理设置。本记录不声称 ZCode 免费。

## 收件与权限边界

回信到达 ZCode 时仅产生 `tool-available`，没有新 native input ID，也没有启动空闲模型。操作者在同一原聊天明确要求收件后，实际 `dialogue_inbox` 工具结果进入原生记录，通信层记为 `tool-read`。本次实测没有证明无提示自动唤醒、原生 prompt 注入、插件商店安装或 Windows ZCode 应用。

ZCode 各工具仅批准当次操作，没有开启“完全访问”或保存项目全局允许。OpenCode 的两次成功 shell 回复也仅批准当次准确的 state/room/from/to/expected-session/parent 命令。

第二次 OpenCode 回复起初缺少测试控制器要求的标记，控制器在执行前拒绝，未发出消息。操作者给出一次纠正指令后完成回复。保留该失败和纠正证据，最终恰好两次成功回复，没有重复全局消息。本记录不是“所有模型操作一次无误”的声明。

## 查看与清理

同轮真实只读 viewer 的 **15 项检查全部通过**：两个健康来源、4 条合并消息、8 份已验签账本副本、3 条回复关系、两种工具状态筛选各 2 条、原生受理筛选仅含 OpenCode 的 2 条、完整 JSON 导出 4 条。ZCode 两条收件均显示“工具可读取”“工具已读取”，没有显示原生受理。

验收后两个准确测试 binding 均已 detach，所属 worker 均确认 stopped；保留两段原生聊天、ZCode 新建工作区配置和私有服务描述。只读 viewer 保留供本机操作者查看历史。完整机器路径、会话 ID、通信身份、访问链接和原文证据保留在忽略目录，没有放入公开结果。

实际接入已有聊天的步骤见 [ZCODE.md](../../docs/ZCODE.md)。本验收使用手动工作区 MCP；随包插件已做结构、命令、Hook 和打包测试，但 3.14.3 插件 loader 对协议字段的保留边界仍需按指南核对。
