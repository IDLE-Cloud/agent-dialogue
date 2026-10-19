# 保留原聊天的暂停、恢复与 worker 停止

更新日期：2026-10-20。这些命令位于最新 v0.3 开发源码，稳定 Release `v0.2.0`、历史通信基线 `00295d7` 和统一预检基线 `0aa51db` 不含本轮生命周期实现。当前运行与 CI 结果以本次提交的验证记录为准；本指南不代表新的稳定 Release 或通用升级/回退验收。版本入口见 [STATUS.md](STATUS.md)。

本文的生命周期错误原因码指模块内部 `code`。当前 CLI 失败时返回非零退出码并在 stderr 输出说明，`--json` 不提供统一 JSON 错误回执；脚本不能假定 stderr 一定包含内部原因码。`inspect --json` 报告中的检查原因码另按[预检合同](INSPECT.md)读取。

## 1. 先选准确通信空间与聊天

所有命令都在该 binding 的所属电脑执行，并使用原来的空间、服务描述和 ledger backend。以下 `SELF` 替换为本机准确 alias；不要选择远端 peer 的本地副本、窗口标题或“最近聊天”。

```bash
export AGENT_DIALOGUE_STATE_DIR=/absolute/path/to/the/existing-space
agent-dialogue inspect --binding SELF --json
agent-dialogue bridge status
```

Windows 在 PowerShell 中设置同一空间：

```powershell
$env:AGENT_DIALOGUE_STATE_DIR = 'C:\absolute\path\to\the\existing-space'
agent-dialogue inspect --binding SELF --json
agent-dialogue bridge status
```

核对完整 binding ID/revision、harness、service/session/project/directory 和 room pins。暂停与恢复沿用这些身份，不建立新聊天、不新建 alias、不修改 cursor/receipts，也不修改原模型或工具批准规则。历史 `detach` 已停用的 alias 不能通过 resume 复活。

## 2. 首次启用：显式离线升级控制 store

新程序继续读写原 v1 store；v1 默认维持原来的 enabled 行为。`bridge pause` / `bridge resume` 要求 v2，遇到 v1 会拒绝并提示 `LIFECYCLE_UPGRADE_REQUIRED`。它们不会为单一 binding 自动迁移正在使用的空间。

升级前必须静止整个空间的写入者；暂停单个 binding 不满足该条件：

`bridge stop` 只管理能按**当前固定安装的绝对 worker 路径、binding ID 和原 token**核验所属的进程。若活跃 worker 来自另一个旧安装目录，新候选会将其归属标记为 unknown；这也适用于旧 POSIX worker，不能假定换一个 prefix 安装后就能接管它。旧 CLI 没有本轮新增的 stop 命令。此时先按已经验证的原安装退出维护流程静止原 worker；无法确认退出就保留 needs-review，不执行升级。跨安装路径的通用迁移流程仍待 ST-06。

1. 核对该空间所有本机 binding；对当前固定安装能够严格确认所属的 worker，逐一 `agent-dialogue bridge stop ACTUAL_ALIAS` 并确认真正停止。其他旧安装的 worker 先完成上述原安装退出维护。`stop` 不停用 binding。
2. 停止向该空间执行的其他 CLI 写入、MCP send/inbox 和 SSH `node receive` 调用；协调 peer 暂停对该空间的投递。只处理本工具所选空间，不停止整台电脑的 SSH/FRP 或其他项目服务。
3. 确认相关聊天不会继续执行写通信账本的工具命令。已经受理的原生模型执行不因 bridge 停止而被取消。
4. 在没有写入者时私有备份完整空间，包括控制状态、节点私钥、账本主文件及必要 WAL、pending 和 receipts。备份由操作者完成；该命令不创建备份。不要在活动 SQLite 上只复制主文件。
5. 使用独立安装目录中的同一固定候选版本；不能覆盖仍在运行的 worker 源码。保存旧程序版本和备份位置，再执行：

```bash
agent-dialogue state upgrade --offline --json
agent-dialogue inspect --json
```

`--offline` 表示操作者声明已经静止全部写入者。程序另外检查已知 worker 的所属进程与退出证据、dispatch/worker 锁、launch reservation 和 Windows launch descriptor；发现 live、unknown、未确认退出或残留锁即拒绝。它无法自动发现所有并行 CLI、MCP 或远端 SSH 调用，不能用该 flag 跳过上述操作。

成功时控制 store 从 v1 变为 v2，并创建独立 lifecycle map；node、binding、room manifest 和 wire 协议身份保持不变。重复执行无需再次迁移。旧二进制的 v1 schema 门禁会拒绝 v2，避免旧 writer 忽略暂停状态；新的 inspect/viewer 能读取 v1/v2。不要将 v2 文件交回旧二进制，或手改 version 以绕过门禁。

对仍活跃的旧 Windows worker，如果它没有 cooperative stop 协议，命令会返回 `LEGACY_WORKER_STOP_UNSUPPORTED`，保留待核对。不能把它当作已停、强制按进程名结束，或在它继续运行时升级。其他未知进程归属、PID 重用和无 owner 的锁也保持待核对。

这只是本次 v1→v2 控制 schema 的离线入口。固定包备份清单、跨版本兼容矩阵、迁移演练和允许回退仍属于 ST-06；详见 [MIGRATION.md](MIGRATION.md)。

## 3. 暂停新通信工作

v2 空间上执行：

```bash
agent-dialogue bridge pause SELF --json
agent-dialogue inspect --binding SELF --json
agent-dialogue bridge status
```

成功提交 pause 后，该 binding 的新直接发送、remote flush、worker 转发、原生输入/所属队首启动和 MCP inbox 新正文读取都被阻止。暂停源 binding 约束其出站；暂停本机目标约束其新正文交付，远端验签入账仍然允许。其他 binding 按各自状态运行。

已经开始的动作持有同一 binding 的 dispatch 锁；pause 等待它结束后才提交暂停。超时返回 `DISPATCH_BUSY`，此次没有成功暂停，不能据此报告“已停止”。遗留锁不会因超时或文件年龄被自动移除。

Windows 的读取共享可能短暂拒绝控制文件或 worker 文件替换。程序只在有限范围内重试同一不可变临时文件；权限拒绝持续、源或目标身份变化时仍失败，保留原文件及未发布候选供核对。它不删除目标、不修改 ACL，也不重试消息或原生输入。发布失败不能当作命令已完成；保留错误和候选证据，不通过清文件或重新发消息绕过。

读结果时区分下列字段：

| 证据 | 含义 |
|---|---|
| `newDispatchBlocked: true` | 暂停已持久提交，新的受控 dispatch 不再开始 |
| `workerAcknowledged: true/false` | 已读取的 runtime 是否记录了同一 lifecycle generation 的 paused；`false` 可能只是 worker 还未确认，不能推断暂停提交失败 |
| `workerObservation: recorded/unavailable` | worker 文件证据是否可读取；recorded 不代表实时进程在线 |
| `pendingNative` / `pendingOutgoing` / `pendingOutbox` | 仍保留的未知结果证据；不可清空后重发 |
| `nativeExecution: not-probed`、`nativeExecutionCancelled: false` | 没有把 pause 当作原生模型取消，也没有宣称模型已经停止 |

已受理的原生输入、已经开始执行的模型任务，以及 pause 前构造完成的工具响应可能仍然继续。暂停不取消它们，也不把它们重置为“尚未投递”。

暂停时 `collab send --queue` / MCP `dialogue_send` 仍可保存 q 请求，回执标记 `dispatch: paused`；这只表示本地排队，没有发送或原生受理。历史和状态仍可读，远端 `node receive` 仍可入账。因此 pause **不是**离线备份或程序替换的全空间静止条件。

ZCode 继续使用原聊天主动调用 `dialogue_inbox` 的 `tool-pull` 模式，`autoWake=false`。暂停时 inbox 不返回新正文、不推进 tool-read；恢复不会自动唤醒空闲桌面聊天。

## 4. 核对同一身份后恢复

```bash
agent-dialogue inspect --binding SELF --json
agent-dialogue bridge resume SELF --json
agent-dialogue bridge status
```

resume 重新核对原 binding 全部身份、相关 room pins、lifecycle generation/nonce、worker 所有权、launch reservation 和准确原生服务/聊天可受理状态。只在这些条件一致时解除暂停，并启动或复用该 binding 的一个受管 worker。不会把另一服务的同名聊天或相同 session 字符串当作原会话。

原生 pending、`outgoingPending`、未确认出站结果、未解决的 launch/stop、未知进程或残留锁会阻止安全恢复。服务已重建、原 session 不存在或 room pins 变化时也拒绝；需要明确重新接入时应新建 binding/room，旧未知事件单独保留。启动结果不明时保留原 reservation，不换 token 重复启动；恢复后启动失败会尝试条件回滚本次暂停解除，不能覆盖另一操作者的新变更。若回滚本身无法确认，错误会明确说明暂停未确认（内部原因码 `RESUME_PAUSE_UNCONFIRMED`）；此时不能假定已经回到 paused，应重新 `inspect` 和 `bridge status` 核对原生命周期与 worker 证据，不重复启动或重发。

当前没有通用的 q→m 自动对账、清 pending 或残留锁恢复命令。这些属于 ST-05；pause 后遇到未知结果会有意停在 needs-review。已有 `node flush --message m_UUID` 能复用准确原 ID，但 source 暂停时同样不能开始 exchange。不要为绕过阻塞而手改 store、清锁、重置 cursor 或换新 ID 发送。

如果 binding 本来 enabled、只停止过 worker，在确认没有 pending/锁且原服务可用后可用 `bridge start SELF`。`bridge start` 不会绕过 paused；paused 必须走 resume 的完整核对。

## 5. stop、pause、detach 的区别

| 命令 | binding 身份 | worker | 直接发送/flush/MCP 等入口 |
|---|---|---|---|
| `bridge pause SELF` | 保留，desired=paused | 可以继续驻留并确认暂停 | 阻止该 binding 开始新的受控工作；queue/入账可继续 |
| `bridge resume SELF` | 保留，核对成功后 enabled | 启动或复用一个所属 worker | 恢复准入；仍受原生服务、路由和审批约束 |
| `bridge stop SELF` | 保留，不改 desired | 请求所属 worker 协作退出并等待确认 | enabled 时其他直接入口仍可用；它不是暂停 |
| `detach SELF` | active=false，历史 alias 保留 | 停用其桥接 | 该 alias 不能 start/resume；新接入用新 alias/room |

stop 与 pause 都不终止整个 harness 服务或删除原生聊天。若同时希望阻止新通信并停下 worker，先 pause，再 stop；重新使用时核对并 resume。若要离线迁移，仍需静止该空间所有其他写入者。

`bridge status` 将 `owned-live`、`confirmed-dead` 和 `unknown` 分开；unknown 的 `running` 是 `null`，不能当作已死后安全重启。viewer/默认 inspect 只显示已记录元数据，不用 PID 存在或 ready 字符串冒充实时在线证据。所属电脑的状态不能代替另一电脑的真实生命周期。

## 6. 继续观察对话与证据

仍用原 room 的 [viewer](VIEWER.md) 查看多机消息、queue 关联、原生受理和工具读取。生命周期显示来自各来源快照；它不会替用户执行 resume、重试或清状态。默认 inspect 只读元数据，显式原生查询及原因码见 [INSPECT.md](INSPECT.md)。正式能力和验证进度见 [STATUS.md](STATUS.md)及[稳定化计划](V0.3-STABILIZATION-PLAN.md)。
