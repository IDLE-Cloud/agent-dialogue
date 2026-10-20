# 固定来源与证据对账

本页适用于最新开发源码的ST-05第一批功能。它提供固定q来源、MCP同requestKey恢复，以及停止worker后的准确receipt修复；完整升级回退、原生pending的操作者恢复入口和真实残留锁处理仍须后续完成。当前稳定Release v0.2.0不包含这些命令。设计与中断合同见[RECOVERY-DESIGN.md](RECOVERY-DESIGN.md)。

## 1. 显式启用v3

先按[生命周期指南](LIFECYCLE.md)核对准确binding及所属worker，并静止该通信空间的**所有**写入者：worker、MCP服务、node receive/flush及其它CLI。pause仍允许消息入账和本地排队，单凭paused不能进行离线迁移。先按[迁移说明](MIGRATION.md)保留完整私有备份，固定候选程序版本，不能覆盖活动worker正在执行的源码。

```bash
agent-dialogue state upgrade --offline --target 3 --json
```

默认省略target仍为此前的v2升级合同。需要重复检查v3升级时继续显式指定 `--target 3`；指定2或默认2不会把v3降回v2。v3保留node身份、bindings、room pins、生命周期、旧pending和账本，不给历史请求猜关联。程序会拒绝已知live/unknown worker、锁、未完成launch和不明旧forwardings数据；`--offline`仍是操作者对全空间静止的声明，无法自动发现所有写入者。

旧v1/v2程序读取v3控制状态时拒绝继续受管写入，但这不是OS权限边界，也不阻止操作者绕过工具直接写数据库或调用原生服务。旧命令可能在读取控制状态前做native preflight；因此不能让新旧程序并行运行。

## 2. Agent的正常用法保持

Agent继续使用自己准确聊天对应的说明和alias。`collab send --queue`仍返回本地 `q_UUID`，它证明本地请求排入，不证明对端或模型完成任务。v3 worker在正式追加前持久保存q与准确正式消息的关联；远端m、时间和payload hash一旦分配就保持。

ZCode继续主动调用MCP，空闲不自动唤醒。`dialogue_send` 使用稳定requestKey：回执丢失后复用**相同key和相同内容**。已持久为queued时返回保存的原回执；追加结果未知时，只有在完整有界历史中找到唯一准确q事件后才补回原回执。缺证据则保持pending，不再追加。普通assistant输出不会自动全部转发。

## 3. 对账一个准确q

先从原queued回执或 `bridge status` 中取得准确submissionId。不要用正文相同来选事件，不要清pending或换新ID来猜结果。

对于远端m，如果binding仍enabled，可以由操作者明确选择原ID执行已有的 `node flush --message m_UUID`。这是实际传输重试，会联系对端；它复用原签名消息和原ID。source已paused时flush也会拒绝，本页的对账命令不会解除暂停或绕过它。没有durable remote-stored证据的情况继续needs-review，找到本地formal frame不表示远端未收到。

在需要修复所属worker的outgoing receipt时，先暂停并正常停止这个worker：

```bash
agent-dialogue bridge pause alice
agent-dialogue bridge stop alice
agent-dialogue bridge reconcile alice --submission q_12345678-1234-4234-8234-123456789abc --json
```

将示例alias和q替换为真实完整值。命令要求v3、该binding paused、准确worker已停止且confirmed-dead、合法matching stopped reservation、没有所属worker锁或未决scheduled launch。`error`终止的worker也必须满足相同死亡与归属证据；query超时、PID存在但不匹配或token变化都拒绝。

可能结果：

| 结果 | 含义 |
|---|---|
| `reconciled` | 准确formal event和必要的远端结果均有证据；只补原receipt、移除匹配outgoingPending，cursor及其它字段保留 |
| `needs-review / absent` | 没找到足够证据，不等于没发生；不追加 |
| `needs-review / ambiguous` | 同身份存在多个候选，不能选择其中一个冒充唯一 |
| `needs-review / incomplete` | 有界扫描到上限或无法证明完整历史，不能据此恢复 |
| `needs-review / append-not-started` | 只有prepared来源，尚未持久取得追加权；此对账命令不授权重发 |
| `needs-review / remote-unconfirmed` | 本地formal关联可查，但远端最终结果未确认；不清pending |
| `needs-review / legacy-or-missing-provenance` | 历史请求没有预分配来源，不能按正文或后来事件补猜 |
| 归属、pins或runtime变化错误 | 原证据保持，重新核对所选聊天、owner和状态 |

对账不发送prompt、不exchange、不启动worker或模型、不推进cursor，也不自动resume；owner证据查询仍可能执行ps或PowerShell。成功后仍检查独立的native pending、其它outbox及锁；只有这些也满足原恢复条件时才显式 `bridge resume alice`。

## 4. 中断、容量与记录

对账先提交控制checkpoint，再发布准确runtime后像，最后标记完成。重试只接受保存的前像或后像：前像应用同一固定delta，后像只补完成标记；任一不匹配继续待核对。原native pending、其它receipt、owner及error均不擅自清除。

如果真实进程死亡留下D/C/worker锁，先用默认只读 `inspect` 和 `bridge status` 保留owner证据。来源对账不会按文件年龄删除锁，也不会把PID存在或无法查询当作已经死亡。本批尚无通用残留锁恢复命令。

主store.json读写均有16MiB上限，按完整UTF-8字节计算。写入超限会在发布前失败，原store保持，不自动裁剪历史记录；若作用已发生而后续记录不能提交，则保留待核对，不能重发。默认inspect另有4MiB及每map1000条的只读预算，超预算表示本次检查不完整，不能据此认定合法大store已损坏。

查看器继续观察room实际消息、回执和工具读取。inspect仅展示forwarding阶段计数及待修复诊断，raw provenance、nonce和token不会进入公开DTO。完整私有证据与阶段验证另按[稳定化计划](V0.3-STABILIZATION-PLAN.md)记录，不能将本机或fake服务合同外推为真实模型/多机实测。
