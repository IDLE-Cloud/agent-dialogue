# 原生输入与有限 C/D 锁恢复：本机快照

本报告记录本批候选源码的平台提交前结果。**本机验证通过，Windows/CI 尚待执行**；这不是新的 stable/RC 或完整 ST-05 验收。准确运行文件摘要、计数和范围见 [metrics.json](metrics.json)。后续结果新建快照，不覆盖本报告的阶段事实。

- Node24.19.0 / Node26.10.0 各824项：823 pass、1 Windows-only skip、0 fail/cancel。相对第一批新增100项，包括严格v4、完整原生输入证明、未知零重发、停后修复、中断/CAS、C/D锁、私有CLI计划和两个真实子worker合同。
- 隔离安装包smoke通过，88文件、313648bytes的临时包；v2→v3→v4、重复升级和inspect保持node与准确store字节，包内包含新模块/指南，运行不改安装目录。临时smoke包没有作为RC保存。
- C/D合同26项及CLI11项独立37/37；真实自有两子进程持锁后终止，OS确死与原inode隔离/幂等检查27/27，控制状态字节保持。
- 原生独审32/32包含两个实际worker。第二个V1 fake服务保存完整user输入后丢回执，实际worker error退出并由默认OS探针确认死亡；强证据修复零第二POST、cursor/无关字段保持、重复幂等。其余fixture的synthetic PID/探针不算OS归属证据。

实现先持久完整原prompt hash及event/frame/binding/route/attempt，进入D后重做阶段门禁，原生查询在C外，返回后全outcome/inbox关联CAS；修复C checkpoint→runtime准确后像→C完成。默认evidence不query原生；Kimi须明确允许加载。C/D退休需原先paused、全空间offline、仅ESRCH确死，独立恢复R与同卷quarantine保留原证据；目录rename不冒称可移植CAS。

独立审查曾发现并修正foreign native client继续POST、query期间phase/receipt覆盖、signed ingress错误wrapper、inbox源关联变化，以及CLI空binding变成C和不可回读output路径。所有先红/绿和fixture自身错误独立保留在私有证据；公开材料不含原正文、nonce、token、私有plan、机器连接或用户路径。

使用方法见 [原生与锁恢复指南](../../docs/NATIVE-RECOVERY.md)，合同见 [设计](../../docs/NATIVE-RECOVERY-DESIGN.md)。Kimi/OpenCode V1提供强persisted user证明；V2/Codex正常成功提交仍可用，其未知提交强恢复暂unsupported；ZCode仍主动tool-pull。worker/scheduled token退休、ST06完整迁移/回退、连续项目试用与RC未完成，ST05整体进行中，稳定v0.2.0。

本批仅隔离embedded、fake loopback、owned children和自动测试；没有真实模型、SSH或既有远端/聊天修改。历史真实通信验收保持独立。GitHub后续平台结果将绑定准确提交，不能使用前一批七组CI冒充本批通过。
