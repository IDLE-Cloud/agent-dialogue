# 原生输入证据与离线锁恢复

本页适用于开发分支的显式 v4 控制状态。稳定 Release v0.2.0 没有这些命令。正常通信、准确聊天绑定和查看方式继续见[中文操作手册](QUICKSTART-ZH.md)；本页处理回执丢失与进程异常退出，实施合同见 [NATIVE-RECOVERY-DESIGN.md](NATIVE-RECOVERY-DESIGN.md)。

## 1. 启用前先保留身份与完整状态

固定所有节点的准确程序提交。按[迁移说明](MIGRATION.md)备份整个私有 state，包含 node 身份、控制状态、账本及 runtime；不要只复制 store.json，也不要覆盖活动 worker 正在使用的源码或安装目录。

让该空间所有 worker、MCP、node receive/flush 和其它 CLI 写入者静止，再执行：

```bash
agent-dialogue state upgrade --offline --target 4 --json
```

`--offline` 是操作者对全空间静止的声明；程序只能拒绝它能发现的活动/未知 worker、锁与 launch，无法自动发现所有外部写入者。pause 允许消息入账和本地排队，单凭 paused 不足以升级。省略 target 仍默认 v2；v4 不支持降回 v3/v2，旧 writer 会拒绝 v4。v3 的 q/MCP/出站修复在 v4 仍可用，见 [RECOVERY.md](RECOVERY.md)。

升级保留原 node、binding、room、pending 和历史。它只为新投递记录来源，不会给旧 pending 猜出来源。若是历史遗留锁阻止升级，先在 v3 上按第 4 节处理；v1/v2 锁保持 needs-review。

## 2. 正常投递增加了哪些证据

Agent 的 send/inbox 用法不变。v4 worker 在提交 prompt 前保存固定 input ID、准确 event/frame/binding/route 的摘要、完整实际 prompt 的摘要和提交阶段；摘要采用完整字符串的 canonical JSON SHA256，控制状态不复制 prompt 正文。先保存 runtime.pending，再取得一次提交权，然后才调用原生服务。

| 阶段 | 含义 | 自动行为 |
|---|---|---|
| prepared | 来源已保存，尚未取得提交权 | 不当成已发送；不靠缺少原生记录推断可重发 |
| submit-started | 已取得提交权，可能已经产生作用 | 结果未知时仅查询原输入，不重新 POST |
| not-submitted | adapter 明确证明提交前失败 | pending 清除后，正常 worker 可用同一 input ID 开始下一次有记录的尝试 |
| admitted | 已保存准确原生受理回执 | 保留原回执；不把模型任务完成与输入受理混为一谈 |

自动未知结果核验和下面的操作者修复，目前只有 **Kimi Code、OpenCode V1** 提供完整持久 user 输入证明。必须同时匹配服务、会话、workspace/project、输入 ID、role 和完整正文摘要；同 ID、前缀、inbox 或 assistant 内容均不足。OpenCode V2/Codex 的普通成功提交仍工作，但未知提交的强证据修复保持 unsupported/needs-review。ZCode 使用主动 MCP tool-pull，不套用原生输入修复，也不自动唤醒空闲聊天。

## 3. 核验与修复一个原生 pending

先从所属 worker 状态取得准确本地数字 event ID。它不同于 `q_UUID`、跨节点 `m_UUID` 或原生 `msg_…`。以下 `alice`、`123` 均替换成原 binding alias 和 event ID。

默认查询只读本地控制元数据：

```bash
agent-dialogue bridge native-evidence alice --event 123 --json
```

该模式不发现原生服务、不读原生聊天、不加载 Kimi session，也不创建账本。`not-probed` 表示有来源但尚未查询；`legacy-or-missing-native-provenance` 表示不能安全关联旧请求，不等于没有发生。

需要主动查询原生证据或修复时，先暂停并正常停止准确所属 worker：

```bash
agent-dialogue bridge pause alice
agent-dialogue bridge stop alice
agent-dialogue bridge native-evidence alice --event 123 --native --json
agent-dialogue bridge native-reconcile alice --event 123 --json
```

Kimi 的两个主动命令都必须额外加 `--allow-session-load`；冷会话读取可能加载会话，未授权时在发现服务前就返回 needs-review。修复本身已经是显式原生查询，不接受另一个 `--native` flag。

主动查询/修复要求 v4、所选 binding paused、runtime 为 stopped/error、准确 matching stopped reservation、owner confirmed-dead，且没有所属 worker 锁或未决 scheduled launch。PID live、无法查询、token 或绑定变化均拒绝。查询期间不持 control 锁，返回后重新核对原始 event、pins、owner 与 runtime。

成功 `reconciled` 只补同一事件的准确 receipt 并移除完全匹配的 runtime.pending。cursor、其它 receipt、nativePending、outgoingPending、状态和 error 都保留。先保存 checkpoint，再发布 runtime 后像，最后标完成；中断重试只接受准确前像/后像，第三种状态保持待核对。命令不会提交 prompt、启动 worker、推进 cursor 或自动 resume。

`input-not-found`、`input-mismatch`、`native-unavailable`、`unsupported-adapter`、`submit-not-started` 和 `known-not-submitted` 都不是授权重发。保留原证据，核对准确原聊天与程序版本。成功修复后还须检查其它 pending 和锁，满足原生命周期恢复条件才显式执行 `bridge resume alice`。

## 4. 确认死亡的遗留 C/D 锁

此入口支持 v3/v4 的 control 锁 C 和单 binding dispatch 锁 D。worker 锁、未知 Windows scheduled launch、损坏 owner、权限异常和无法证明死亡的 PID 均保持 needs-review。不能按文件年龄删锁；先使用默认只读 inspect/status 保留证据。若遗留 C 本身已阻止 pause，且空间没有事先 paused，本入口也不会修改状态绕过门禁。

在所有写入者已静止、相关 binding 已经 paused 的维护窗口中，只读生成报告：

```bash
agent-dialogue lock plan --json
agent-dialogue lock plan --binding alice --json
```

第一条选择 C，第二条只选择 alice 的 D。只有实际 `ESRCH` 才认定 PID 已死亡，PID 存在或查询失败都不接受。报告只含可公开摘要，不含可执行私有计划。

选定准确锁后，将计划写入一个**已经存在**、属于当前用户的私有目录；目录在 POSIX 应为 0700，Windows 应为当前 SID 私有 ACL。路径示例需自行替换，命令不会创建父目录、修已有权限或覆盖已有文件：

```bash
agent-dialogue lock plan --binding alice --output /private/maintenance/alice-lock-plan.json --json
agent-dialogue lock retire --plan /private/maintenance/alice-lock-plan.json --offline --json
```

Windows 可使用同一 CLI 和私有 Windows 绝对路径。私有 plan 含所有权和文件身份信息，不提交 Git、不粘贴到 room 或公开报告。plan 不 ready 时不创建输出文件。

retire 再次核对 offline、paused、确死 PID、原目录/owner 和其它已知 producer。它通过独立恢复锁 R 串行化恢复者，把准确原锁目录转存到同卷私有 `dialogue/lock-recovery/quarantine/`，保留 checkpoint 与原证据，不递归删除。R 不约束普通 writer，目录 rename 也不宣称可移植的 CAS，因此显式全空间离线是必要条件。

重复执行只接受准确原像或准确隔离后像；原位置出现新 owner、checkpoint/quarantine 被改动或恢复者锁异常都停止，不覆盖、不危险回滚。成功后仍 paused，不改变 store、runtime 或账本，不启动原生服务或重放消息。后续是否 resume 仍按[生命周期指南](LIFECYCLE.md)核对。

## 5. 验证范围

本批自动合同使用隔离 state、embedded ledger、完整原生记录的 fake 服务，以及真实自有子进程留下的 C/D 锁；测试、包安装和平台结果另存 verification。它们验证恢复机制，不能替代指定真实 harness/物理机的模型联调。已有 Windows、VPS、Kimi 和 ZCode 通信实测仍见 [STATUS.md](STATUS.md)。完整迁移/回退、worker token 退休和连续真实项目试用继续按[稳定化计划](V0.3-STABILIZATION-PLAN.md)验收。
