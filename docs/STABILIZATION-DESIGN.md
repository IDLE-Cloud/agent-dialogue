# v0.3 预检、生命周期与恢复设计

设计基线：d861b5b；范围对应 [稳定化计划](V0.3-STABILIZATION-PLAN.md) 的 ST-02。本文是实现合同，完成状态以任务表和测试证据为准。尚未实现的命令不能直接用于现有安装。

## 1. 复用边界和模块职责

现有原生 adapter、签名 room、队列、账本和 viewer 保持职责。`node flush --message m_UUID` 已有原 ID 对账能力；`detach` 会停用绑定，不能用作暂停。新逻辑放在共享模块，CLI、worker 和 MCP 使用相同准入规则。

| 模块 | 已有职责 | 最小增量 |
|---|---|---|
| `lib/inspect.mjs`（新增） | — | 本地无写入快照、封闭字段报告、明确选择的原生深查 |
| `lib/lifecycle.mjs`（拟新增） | — | 每 binding dispatch 互斥、统一准入、生命周期与 generation 条件校验 |
| `lib/bridge-store.mjs` | 绑定、room、原子控制状态 | 兼容性门禁、control 锁 owner、生命周期字段校验 |
| `lib/bridge.mjs` | worker、原生受理、出站队列 | pause/resume、所有实际工作前的共享准入、准确在途状态 |
| `lib/nodes.mjs` | 签名发送与原消息对账 | flush 发送临界区、持久 q→m 关联 |
| `lib/submissions.mjs` | 本地 q_UUID 提交 | 允许暂停时排队、显式显示尚未投递 |
| `lib/mcp-tools.mjs` | 准确 scope 和工具收件 | inbox 与暂停共用准入；status/context 保持可观察 |
| `lib/native-admission.mjs` | 稳定 input ID、先 intent 后提交 | 继续复用已有对账，不为恢复添加第二次 POST |
| `lib/viewer/` | 只读观察 | 投影暂停/待核对证据，不拥有恢复动作 |

原生模型、审批和原用户聊天的生命周期仍由 harness 管理。ZCode 的工具收件保持 `tool-pull / autoWake=false`。本设计不建立自动进程拉起、任务分工或新消息后端。

## 2. 统一预检合同

拟新增：

```text
agent-dialogue inspect [--binding ALIAS] [--room ID] [--json]
agent-dialogue inspect --binding ALIAS --native [--allow-session-load] [--json]
```

默认只读当前明确选择的 state/cache 路径、已有身份、控制 store、所选 worker 状态及锁元数据。不得初始化 node、创建目录/缓存、打开可写账本、执行 harness CLI/hcom/SSH、提交模型输入或重新启动 worker。Windows 可以调用既有平台权限核验工具验证私有身份权限；这不等于运行原生聊天或第三方 harness。不存在的 state 是尚未配置，不能报告节点在线。

不直接串联已有 `doctor` 或 `node status`：前者会执行工具版本命令，后者会初始化 node。默认不打开 SQLite，只报告账本文件存在及格式证据；文件存在不证明库完整或可投递。`doctor` 保留原用途。

报告为版本化、封闭字段的对象，至少包含：

```json
{
  "schemaVersion": 1,
  "command": "inspect",
  "mode": "local-metadata",
  "overall": "unconfigured",
  "effects": {"sourceWrites": false, "nativeContact": false, "sshContact": false, "thirdPartyExecutables": false, "modelTurns": false},
  "checks": [
    {
      "id": "binding.selected.native",
      "code": "NATIVE_NOT_PROBED",
      "status": "not-probed",
      "evidence": {"kind": "not-requested", "source": "local-control", "probed": false},
      "message": "原生服务尚未查询。",
      "actions": [{"code": "INSPECT_NATIVE", "command": ["agent-dialogue", "inspect", "--binding", "selected", "--native"], "mutates": false, "mayLoadSession": false}]
    }
  ]
}
```

`status` 只能是 `ok / warn / blocked / not-probed / needs-review`；`overall` 是 `unconfigured / ready-local / needs-review / blocked`。`ready-local` 仅证明本地元数据自洽。`code` 是调用者可匹配的稳定原因码，不从原始异常文本生成。未探测、持久记录和实时证据必须分开。worker 文件里写着 ready 不证明进程仍活着；PID 存在也不证明是该 worker。默认不会把这类记录提升为在线。

退出码：0 表示生成可解释报告，包括 unconfigured、warn 和未探测；1 表示 blocked 或 needs-review；2 表示调用或路径配置无效，使用固定安全错误，不回显原始异常。报告包含分组计数、路径和被明确选择的身份，不把未选择的聊天误当预期目标。

本地操作者需要看到明确选择的完整 binding ID/revision、harness、service/session/project/directory 及 room pins，以便核对聊天。报告不包含 privateKey、进程 token、peer 传输配置、MCP scope 内容、聊天正文、原始错误或凭据。默认报告用于本机排错；公开验收投影继续采用更小的独立 allowlist，不能直接发布整份本机报告。

深查只查询明确选择的本地 binding，复用 `withNative/inspectBinding` 验证服务身份、完整 session、project 与 cwd；不调用 prompt、resume、queue start 或创建聊天。原生查询可能更新 harness 内部元数据，因此 `sourceWrites=false` 只约束本工具 state，不承诺 harness 内部零写入。Kimi 的 session 查询可能加载冷会话：只有额外提供 `--allow-session-load` 才可进行，报告必须声明该元数据查询副作用。无此 flag 连 discovery/meta API 也不调用，返回未探测及下一步。远端 binding 的原生深查拒绝，由所属电脑运行；本阶段不增加隐式 SSH 探测。

检查读取有大小上限，拒绝符号链接、非普通文件、无效格式和读取期间变化。遇到损坏或不支持的 state，只输出固定诊断并保持原字节。新命令必须在任意 cwd、未 setup、state/cache 均不存在时可运行。退出码表达检查发现的阻塞，不以未探测冒充可用。

## 3. 暂停是绑定的持久准入状态

拟新增 `bridge pause ALIAS`、`bridge resume ALIAS`。它们保留 node、binding ID/revision、service/session/project/directory、room pins、cursor、pending 与 receipts。`active=false` 仍是 detach；暂停不修改路由身份或签名 manifest。

生命周期存在控制 store 独立的 `lifecycle[bindingId]` 中，不修改 binding 身份字段。ST-04 固定新增 `store.version=2`，首次启用生命周期时迁移；新 writer 读取 v1/v2，v1 缺生命周期按原 enabled 解释。已有旧 writer 的 version=1 门禁会拒绝 v2，因此不能只在 v1 store 添加一个旧二进制会忽略的 `paused:true`。wire、node、room manifest 不因此升级。viewer 和 inspect 在 ST-04 同步添加 v2 只读支持；当前未落地前仍应拒绝未知版本。

拟用 `lifecycle[bindingId] = {version:1, bindingRevision:1, desired:'enabled'|'paused', generation:正整数, changeNonce:UUID, changedAt:ISO, reason:封闭原因码}`。pause 幂等不凭空增加 generation；resume 比较完整 pins、generation 和 changeNonce 后条件更新，防止旧快照覆盖较新的暂停。changeNonce、dispatch 锁 nonce、worker token 各司其职，不互相替代。操作不写 worker cursor/receipt 文件。

默认允许的动作：

| 动作 | enabled | paused | needs-review |
|---|---|---|---|
| 验签并持久接收远端消息 | 允许 | 允许 | 允许；仍需路由有效 |
| 保存本地 q_UUID | 允许 | 允许，明确 paused | 允许，明确 pending |
| 读取状态、context、viewer | 允许 | 允许 | 允许 |
| 开始出站直接发送/flush/worker 转发 | 允许 | 拒绝 | 按原消息证据限制 |
| 开始原生输入或启动原生队首 | 允许 | 拒绝 | 仅允许明确的只读对账 |
| MCP inbox 返回新的正文 | 允许并记 tool-read | 拒绝；不推进读取记录 | 不冒充 native admission |

只有所属本地 binding 可暂停/恢复。远端状态由所属节点报告，不能把本地 peer 副本改成“远端已暂停”。暂停源 binding 约束它的出站；暂停本地目标约束新正文交付/原生受理，入账本身继续。

暂停与实际副作用使用同一份 **本地、每 binding 的 dispatch 互斥** 形成顺序。现有全 control 锁只保护短状态事务，不能持有它跨节点 exchange：A 等待 B 的 receive control 锁、同时 B 等待 A，可能构成锁环。

统一顺序为 dispatch → control；禁止 control → dispatch，也不同时持有 source 和 destination 的两个 dispatch 锁。source 发送只取 source 锁；destination 的 native admission、drain、MCP inbox 只取 destination 锁。本地发送到暂停目标只入账，之后目标独立准入。`operator` 无 binding 生命周期，不借另一个 alias 绕过 source 检查。

```text
pause(alias):
  acquire this local binding's dispatch lock
  acquire control lock
  validate exact active local binding and feature compatibility
  persist paused without changing identity, cursor or receipts
  release lock
  release dispatch lock
  report paused + observed pending/inflight evidence

admit_or_forward(binding, action):
  acquire the affected binding's dispatch lock
  control transaction: reread identity and enabled; persist stable intent
  release control lock
  perform one bounded action while still holding dispatch lock
  control transaction: persist exact result/unknown evidence
  release dispatch lock
```

pause 等待锁期间还没有暂停成功，已有操作可以完成。超时返回 busy，不能写成“已暂停”。拿到 dispatch 锁并提交 paused 后不再开始新工作；若已有无法证明结果的 pending，就如实显示 needs-review，不强杀进程、不清 pending。网络或原生长调用需保留已有操作 deadline，锁不是无限等待承诺。开始动作的 permit 不落成脱锁后可任意延迟消费的许可；否则必须另设计可枚举的 durable inflight，不属于本次最小实现。

出站远端的准备、账本保存和最终 exchange 可能跨多个临界区。每个开始副作用的临界区都重新校验；准备后暂停可留下安全的原 ID 待投递。`flush` 的最终准入至 exchange 必须持有 source dispatch 锁；`receiveEnvelope` 只做验签入账，只取 control，永不取 dispatch，也不等待 native/worker，因此不形成双向节点发送的锁环。共享 helper 区分“已持锁”与“自行取锁”入口，用内部不可伪造 permit 传递所属临界区，禁止 `locked → locked` 或 dispatch 的递归自等待；不把整个 `forwardSubmission` 外套锁后再调用会取同一锁的 send。必须用真实双向并发 fixture 覆盖该顺序。

worker 暂停后不推进未处理的工作事件 cursor；继续监听或停驻不得丢事件。`start` 必须遵守已暂停状态，不能绕过 resume。MCP inbox 的最终 scope/准入校验、正文选择、tool-read 记录与返回许可同样在 destination dispatch 临界区决定，不能仅检查进入函数时的旧快照；已构造的工具响应可能在 pause 之后才被原聊天读到，不能把这种在途读解释为新开始的投递。`dialogue_send` 仍可保存 q；其 receipt 必须说明排队不等于发送。

dispatch 锁使用固定 binding ID 路径和私有 owner/nonce，原子 mkdir 获取，finally 仅释放自己持有且未改变的 owner；持有者异常退出留下可审计锁，后续拒绝继续，待按第4节证据恢复。新/旧程序不共识该锁：v1→v2 迁移必须先静止旧 writer，pause 对 v1 返回 upgrade-required，不能对单一 binding 自动迁移并假定旧 flush 已停。受控离线迁移、兼容门禁及回退在 ST-04/06 一起验收。

## 4. 恢复与锁所有权

resume 先核对同一完整身份、room pins、pending 和旧 worker 所有权，再在 dispatch → control 顺序下对原 generation 条件更新、显式解除暂停并预留唯一 worker 启动 token。等待 worker ready 前释放 dispatch，避免新 worker 等待同一锁而自锁。若启动结果未知，保留 reservation，不换 token 再 spawn。detach 同样遵守 dispatch → control 标记 inactive，释放锁后才等待所属 worker 清理。

启动串行 reservation、dispatch 锁和 worker 自身锁是不同层：分别约束并发 spawn、实际副作用准入、实际 worker 所有权。owner 至少关联 PID、不可猜测 token、binding ID/revision、节点身份、角色及实际启动证据。

进程核验是三态：owned-live、confirmed-dead、unknown/mismatch。PID 不存在可以作为死亡证据；查询超时、权限不足、PID 存在但命令不符都不得作为可删除锁的证明。Windows 沿用严格 PID/命令/token 核验，不按进程名批量终止。

残留锁恢复是显式操作：先输出恢复计划和 owner 证据，再在独立恢复互斥下重新读取同一 owner 与状态；仅 confirmed-dead 才处理所选锁。无 owner、活 owner、未知查询、PID 重用、读取变化都拒绝自动删除。旧 control `.lock` 没有 owner 时保持待人工核对，不能用文件年龄作依据。先实现报告与拒绝合同，再增加有证据的有限恢复。

resume 遇到 outgoingPending 或不可判定的原生 pending 不能清空后继续新投递。恢复错误仍保留暂停、原身份与原进度。服务重建、同名聊天或相同 session 字符串不足以证明身份延续；发生改变须新 bind/room/scope，旧未知事件单独保留。

## 5. q、m、原生 input 各自对账

### 已有 m_UUID

继续使用 `node flush --message m_UUID`。验证原 payload hash、签名、路由和 room pins，接收端返回同一入账 event；失败保留 unknown，原 remote-stored 证据不被后续失败覆盖。暂停时可以只读查看证据，但不能偷偷执行 exchange。

### q_UUID 和 outgoingPending

当前只保存 eventId/submissionId 不足以证明后续 m，历史记录不可自动补猜。新增出站必须在发出任何请求前持久关联 source binding/revision、q_UUID、submission event、目标 pins、内容 hash 以及确定的 m_UUID（远端）。采用私有 `store.forwardings[q_UUID]` 与 outbox 的双向来源关联，不给 wire v1 的 exact schema 随意加字段。远端正式 frame 已有 m；本地 frame 可增加受核验的 `forwardingId`。正文不复制进 worker runtime。

最小关联包含 `version, submissionEventId, submissionHash, bindingId, bindingRevision, roomId, roomRevision, destination pins, kind, dispatchId, phase`，远端另有固定 `messageId, createdAt, payloadHash`。正文从同一准确 q event 还原，使用原时间/pins 重建确定的 canonical payload 并核 hash，再由同一 node 签名；不能重新分配 m 或时间。首次外部 append 前先持久 `append-started`。在 `prepared` 时暂停仍可证明尚未 append；`append-started` 而找不到准确正式 event 时必须 uncertain，不能自动补 append。

```text
forward(q_event):
  validate source event/sender/pins
  if durable forwarded receipt exists: return it
  if old incomplete pending has no provable association: needs-review
  allocate and persist one formal-message intent + q association
  if still prepared: persist append-started, then append exact frame once
  otherwise: only recover one exact associated ledger event; missing => needs-review
  for remote message: flush that same m_UUID
  persist forward receipt; only then advance cursor
```

账本 append 的结果丢失也要通过明确关联、签名/hash、发送者类型、thread、delivered_to 和完整 pins 恢复；零个或多个匹配都保持待核对，不能按相同正文匹配。若账本缺唯一性能力，不宣称端到端 exactly-once；遇到无法排除重复的窗保持 needs-review。MCP requestKey→q 的 preparing 状态同样要先分配固定 q 与 hash，再追加；历史 preparing 缺关联保持待核对，不能清 key 新发来解决。

### 原生 pending

复用稳定 input ID 和 `admit` 的先持久 intent、单次 prompt、失败只读 reconcile。支持的 adapter 使用稳定原生输入及完整内容证据；已确认 notSubmitted 才可持久清除 intent。找不到输入与输入不存在不是同一结论，查不到保持 pending。恢复不能第二次 POST 猜结果，也不改变用户原队列顺序。

ZCode 没有原生 input admission：工具可用、工具已读取是独立证据，不生成假 input ID，不套用 native pending 的重放规则。

## 6. 升级、备份和回退合同

首版采用可审查的离线操作流程，不先建设通用升级守护进程。至少确认 bridge、MCP send/inbox、node receive/flush 和其它 CLI 写入者已静止；pause 允许入账，因此单凭 paused 不能证明 state 可离线复制。

备份包括同一时点的完整 state、ledger 主文件及必要 WAL、node 私钥、控制状态和所有 pending，存放在仅所属用户可读的私有目录。记录旧/新包 hash、程序版本、ledger backend、state feature/schema、文件清单/hash 和来源；不把私钥或完整备份提交 Git。不得在活 SQLite 上只复制主文件。

候选程序安装到独立 prefix，不覆盖正在执行的 worker 源码。安装不隐式 resume，不把 hcom 与 embedded 互转。先 `inspect` 默认只读核对身份、兼容性、历史文件存在等元数据和 pending；完整历史使用既有只读 viewer/快照另验，再由操作者显式按同一绑定恢复。

回退只能选择经证实兼容的新 state，或旧程序加原升级前备份。旧程序看不懂生命周期功能时不可直接写新 state。若升级后有消息，先离线保留新 state/导出差异；不能用旧备份静默覆盖或自动重放。源 state 与其克隆不得作为两个活动节点并行运行。

ST-06 须补固定版本兼容矩阵和操作演练证据；本文不宣称 v0.2/v0.3 当前可无损互相回退。

## 7. 测试与交付顺序

先写失败测试，再修改运行代码。文档当前性检查与运行验收分开记录。

1. 预检：全新缺失 state/cache 无写入；损坏/链接/大文件/中途变化拒绝；无模型/SSH/hcom；秘密不进报告；任意 cwd 安装包能用；明确 native 深查只读且关闭 client；Kimi 无额外 flag 不查询。
2. 生命周期：同 ID/revision/pins/cursor 保持；并发 direct/flush/worker/native drain/MCP inbox 与 pause 顺序；busy/在途/unknown 不伪装停止；暂停时 q 可入账；对照 binding 不受影响。
3. 恢复：原 m 重试复用既有测试；q→frame→m 持久关联丢回执；旧 pending 拒绝猜；稳定 input 对账不第二次 POST；live/dead/unknown/复用 PID/无 owner 锁分别覆盖。
4. 升级：静止副本/固定包/不兼容拒写/保留新增消息；Windows ACL 和所属进程合同不能降级。
5. 完成无模型合同后，再按计划 R07 在两台物理机、两种 harness 的准确项目聊天中有界试用。历史多机证据不改写成本阶段新功能实测。

自动化先用现有 fake adapter、真实所属子进程和 embedded ledger helper。平台 CI 复用 Linux22/24/26、macOS24、Windows24。真实服务器、模型和桌面试用保持独立证据，只有相关运行合同改变才重跑必要组合。


## 8. 2026-10-20 ST-04 实施进度

共享 `lib/lifecycle.mjs`、v2 lifecycle schema、严格 dispatch/control owner、所有直接/worker/MCP 工作的 D→C 准入和原 binding 的 pause/resume 已实现，另提供 cooperative `bridge stop` 与显式 `state upgrade --offline`。实际操作及旧安装 worker 边界见 [LIFECYCLE.md](LIFECYCLE.md)。本机全量与安装包结果以本次 verification 记录为准，平台 CI 独立验收。

本节不改写前文设计历史。ST-05 的 q→m 持久来源、安全锁恢复与完整原生 pending 对账、ST-06 的固定版本迁移/回退演练仍待实施。未知证据不删除，另一个安装路径的旧 worker 不自动接管，默认不调用模型或远端。
