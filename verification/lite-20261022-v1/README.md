# Lite 本机首版验证

源码候选：`861007a8e4d939c7a8b6bab346e1f1abdf904b5d`，基于 main `f576ecba35c1819ff0fb96278e51ea92541ba772`。本页记录本机首片，尚未代表 Lite 多机部署或稳定发行。结构化数据、来源边界和摘要见 [metrics.json](metrics.json)。

## 已完成

- 独立包 `packages/lite`、命令 `adl`、独立数据目录；一个 SQLite Hub、每机一个 Node，CLI/MCP 四个工具与只读网页。
- OpenCode 已有聊天的准确绑定、原生输入、显式工具回复；通用 CLI/MCP 工具收件。
- 消息 ID 去重、持久受理、每收件人一次投递许可、忙碌聊天隔离、结果不明不重投。
- 操作者停止旧 Node 并检查原聊天后，可结算 unknown，保留核对说明；不会重新投递原消息。

## 确定性与安装验证

macOS 上 Node 24.19.0 / 26.10.0 各 **43/43**，零失败、取消或跳过。包含真实子进程在事务提交前、提交后和原生尝试检查点被终止的测试，核对回滚、已受理消息保留、unknown 及原生尝试次数。

两个 Node 版本均完成独立 tarball 安装、源目录以外执行 CLI、安装后的 Hub/SQLite/API 与网页资源检查。临时安装路径包含空格，npm 通过 Node 直接运行，无 shell。旧根包没有导入 Lite，旧 `lib/bin/web/viewer` 运行代码保持不变。

只计算 Lite 的 `lib/bin/web` 下运行源码（包括复用协议客户端和网页），共 **14 文件 / 1816 行**，无第三方 npm 运行依赖。行数含空行和注释，只说明当前体量，不等同于性能或维护成本。

复现：

```sh
cd packages/lite
npm test
npm run test:package
node scripts/measure-local.mjs
```

## 真实模型往返

本机 OpenCode **2.0.20**，目录实时核对为零价格的 `opencode/deepseek-v4.1-flash-free`。两段独立测试聊天先各自获得不同上下文，再用完整 session ID 绑定到两个独立 Node 身份及两个 CLI Node 进程。只批准两条经过核对的 `adl send` 命令各执行一次，Lite 自身未更改 harness 审批策略。

1. A 原有上下文保存预算 17，向 B 发出问题。
2. B 收到该消息的原生输入，结合原有的 `.json` / 旧记录兼容要求，经 CLI 发回关联回复。
3. A 在同一聊天收到回复，最终同时引用预算、兼容要求和回复消息 ID。

结果：**2 条 Hub 消息、1 条 replyTo、2 次原生受理、2 次成功的原生 shell 通信工具调用**。每条 peer 输入只在目标原生聊天出现一次；最终可见回答包含双方约束。详细正文和凭据仅保留在本机私有证据目录。

失败与修正独立保留：首轮 A 在当前轮持续等待并尝试 help/猜测 recv，测试控制器拒绝额外命令。明确“发送后结束本轮，Node 在空闲后自动推送”后完成往返，此提示已加入 adapter 与使用指南。第二组准备阶段模型把确认标记拼写成 `RESPOND_SER_LITE_READY`，严格标记检查超时；核对原生已空闲且 seed 已保存后继续。该组对话阶段不再改模型指令，完成两条发送与关联回复。

真实模型运行后又增加了 descriptor 版本变化拒绝、V1 shell 选择、人工 unknown 结算与原子配置更新；它们由最终候选的合同、单测和安装测试覆盖。本次模型样例未执行 V1 或未知结果人工结算，不将其外推为这些路径的真实模型验收。

## 控制延迟样本

同机、真实 HTTP/SQLite、两个 Node 身份，native adapter 使用 stub，不调用模型。10 条关联消息，重复原生尝试 **0**；Hub accepted 的 p95 **4.86ms**，发送到 delivered 的 p95 **258.05ms**。这是小样本控制链路，不包含模型执行或物理跨机网络，不构成 SLA。原始样本及合并测量进程的资源数据见 JSON。

## 尚未验收

- Lite 在 VPS、Mac、Windows 多台物理电脑之间的真实通信和断线重连。
- Lite 的 Kimi、Codex、ZCode 原生推送；通用工具收件不能推导为任意桌面聊天自动唤醒。
- OpenCode V1 的本轮真实模型测试。
- 完整浏览器登录后的视觉检查。已做登录页实际打开、网页 DOM 纯文本/XSS 行为、实际 Hub cookie/权限/102 条分页及不标已读集成测试。
- 本快照之后的托管 CI 终态；后续状态另行记录，不回写成测试时已经通过。

下一阶段使用现有 VPS 放 Hub，Mac/Windows 各运行一个 Node，沿用同一协议验证跨机往返与离线补投。[使用指南](../../packages/lite/README.md)和[给 agent 的说明](../../packages/lite/docs/AGENT-GUIDE.md)已随包提供。
