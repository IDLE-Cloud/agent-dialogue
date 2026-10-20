# ST-05 固定来源与证据修复实施合同

日期：2026-10-20。用户已授权继续实施；本设计细化既有ST-02第5节，不改变既有任务身份或历史结果。ST-05保持进行中，本文不将设计或本机验证写成平台验收已完成。

第一批实现固定q来源、跨节点固定m、MCP单次追加和暂停且停止worker后的证据修复。已有m的原ID重试和原生input的先持久intent/只读核验继续复用；没有准确证据的历史pending仍是允许的needs-review终态。真实崩溃残留锁的实际处理需独立owner恢复合同，不在来源对账过程中删除或绕过。

## 控制格式与兼容

显式 `state upgrade --offline --target 3` 启用v3。默认target 2保留此前命令合同；新程序明确读取1/2/3，未来版本拒绝。v3保留v2生命周期与私有权限检查，新增严格 `forwardings`；新MCP version 2记录使用prepared/append-started/queued阶段，历史preparing记录不猜迁移。旧v1/v2程序不接受v3；新增top-level map不能作为旧writer隔离。离线声明仍由操作者静止所有CLI、MCP和SSH写入者，程序另拒已知live/unknown worker、锁与未完成reservation。迁移不推断旧q关联、不清pending、不改node/room/wire身份。

`forwardings[q]` 保存准确原事件ID和完整submission hash、source binding/revision、room、完整route hash、dispatch UUID、phase、正式frame hash与正式event/result。远端另固定m、createdAt、payloadHash，outbox以同q/dispatch反向关联。正文留在原账本，签名准备对象和私钥不复制进控制记录。

## 单次正式追加

```text
source D内核验准确q/sender/room/pins
在C外完成准确native身份和reply parent只读查询
同一C提交forwardings prepared（远端同时提交outbox provenance）
所属worker持久outgoingPending
同一C条件提交prepared -> append-started，只有该调用赢得追加权
保持D追加一次准确formal frame；丢回执不重新追加
核验实际formal event后C保存local-stored
远端复用同一个m执行既有flush；没有remote-stored证据不记已转发
C保存确定result，再保存worker receipt并移除准确pending
正常worker仅在receipt持久后推进cursor
```

MCP先保存requestKey对应的固定q、hash和完整pins。prepared→append-started同C只允许一个winner；重试重建同一q后比对，追加结果未知只扫描，不另分配身份。每次host/scope查询在C外，每个实际ledger副作用前在C内重查pins和schema。新旧分支都不能跨schema继续旧工作。

扫描按准确q/m/dispatch身份挑出所有候选，完整唯一之后才核验sender kind、实际from、thread、intent、唯一recipient、frame/signature/hash及完整pins。使用升序分页，默认最多10000事件；零候选、多候选、超限、损坏或不递增页都不授权追加。恰好到上限还须look-ahead证明结束，不把last1000查询冒充全历史唯一性。

## 已停止worker的修复顺序

`bridge reconcile ALIAS --submission q_UUID` 仅在v3、所选binding paused、准确worker已退出且confirmed-dead、matching stopped reservation、无所属worker锁/未决scheduled launch时操作。持一个source D，不持peer D；native/网络查询不占C。查询不到归属、无来源或结果不够均保留待核对。

```text
读准确runtime bytes前像和owner hash
只读核验准确q及完整唯一formal evidence
再次核验runtime/owner/lifecycle/room/锁
C提交确定结果及checkpoint（前像hash、确定后像hash、固定receipt时间与最小delta）
保持D，重查前像和停止证据，原子发布准确runtime后像
C标记runtime-committed；不自动resume
```

重试见前像时只应用同一delta，见后像时只补完成标记；两者都不相等拒绝。只新增准确forwarded receipt并移除匹配的outgoingPending，cursor、native pending、其它receipt、owner和其它runtime字段保持。控制与runtime两文件不伪装成原子事务；真实进程死亡留下的D锁先经独立owner恢复，异常finally释放的测试不能替代这一门槛。

## 验证与证据

自动测试复用embedded ledger、受控子进程与原adapter合同，不触发真实模型或远端部署。分别覆盖每个持久化边界前失败、append回执丢失、同ID冲突候选、跨schema变化、并发claim、owner live/dead/unknown、runtime前后像中断及不相干字段保持。Windows采用真实SID/ACL合同，不放松生产权限deadline。

私有原始证据存 `.state/recovery-20261020-vN/`，公开投影放 `verification/recovery-20261020-vN/`；研究记录仅追加至独立研究项目，源提交/hash、红/绿和平台阶段分别保存。首次实现结果未收口前，本文不是完成声明。
