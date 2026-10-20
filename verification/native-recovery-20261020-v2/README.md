# 原生与锁恢复：首次 Windows 失败及安装补充

本快照保留 [本机 v1](../native-recovery-20261020-v1/README.md)之后的实际失败及修正。运行源码仍为 c44bc9d117b455b692a7ac5229e05dd69e08fe74 的61文件，标准摘要不变；**本轮修正只有测试 fixture 和 CI 环境初始化，Windows 复验尚待执行**。精确字段见 [metrics.json](metrics.json)。

首次 [CI39426418555](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39426418555) 的 native-recovery 组42项：36pass、6fail、0cancel/skip。五项失败源于测试把POSIX目录直接当Windows绑定路径，实际adapter会归一化目录/项目ID；fixture改用平台resolve和真实adapter返回的projectID，生产严格匹配不放宽。Node24/26相关四文件各66/66绿。

第六项在第一个对抗case的fixture创建阶段，Windows ACL provisioning约8080.9ms失败，尚未生成node key、写store/ledger或调用prompt。原生runner将timeout/exit统一脱敏，不能据此断言冷启动为已证明原因。CI增加独立只读WindowsPowerShell身份/ACL元数据初始化和计时，所有实际产品权限检查仍保持8秒fail-closed，未skip或放宽。其它四Unix组和Windows forwarding已success，剩余Windows在本快照时仍运行；不提前算本批平台通过。

补充安装验收已完成：真实旧63fba v3五writer fence143/143，独立264项源码/Git比对；升级只加v4/nativeIntents，身份、历史、pending和state/cache完整字节/权限保持。只证明指定旧入口读store后拒写，不外推全部preflight或完整ST06。

保留的同一tarball在新隔离prefix的默认launcher **103/103**：两个实际worker各spawn1，pause/resume同PID/token，一q→formal→forwarded→admitted nativeIntent，磁盘持久fake input/POST各1、重复0，准确正常stop后两PID confirmed-dead。88/88 tar内容+权限匹配安装，安装前后完整manifest相等，30次入口权限采样全755，包watch事件0；61runtime逐Git一致。实际保留包315900bytes、SHA b8ad8a39a6a01dac1d41a7ea6bb6a61c953d51b2bc40624c6efe9126e357169d，不能与CI临时315896bytes或未来RC混称。

首次launcher在77断言后EACCES，原失败保持。原因已由原工具调用确认：审查记录脚本错误地递归修改共享证据树文件权限，触及并行测试安装；已禁止共享父树chmod。两ownedworker通过固定Node读取准确installed CLI正常stop并确死，不原地修权限或直接发信号；新prefix使用原包复验。v1中package-smoke“安装目录不变”仅指目录项目和外置state/cache；完整内容/权限守恒由此补充runner单独证明。

使用见 [指南](../../docs/NATIVE-RECOVERY.md)。ST05整体进行中，worker/scheduled token退休、V2/Codex强恢复、ST06和RC未完成。本批没有真实模型、SSH或已有多机服务变更；stable仍v0.2.0。
