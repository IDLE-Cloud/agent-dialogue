# 原生输入与有限 C/D 锁恢复：最终平台验收

本批选定范围通过独立审查、本机及[九组CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39428225797)。实现提交 c44bc9d117b455b692a7ac5229e05dd69e08fe74，测试/CI修正提交 4108b08e41ba4ea77ed4e1f57f3605b9c62073aa；两者61个运行文件和权限逐项一致，标准摘要7ec88027e61bba31be457b5ed05c17863d214e2ed4a4f7878a8844ce08efd19d。准确计数与原始日志hash见[metrics.json](metrics.json)。

| 组 | 实际Node | tests | pass | skip | fail / cancel |
|---|---|---:|---:|---:|---:|
| windows-lock-recovery | 24.21.0 | 50 | 45 | 5 | 0 / 0 |
| windows-native-recovery | 24.21.0 | 42 | 42 | 0 | 0 / 0 |
| windows-native | 24.21.0 | 342 | 337 | 5 | 0 / 0 |
| test (ubuntu-latest, 26) | 26.12.0 | 824 | 823 | 1 | 0 / 0 |
| test (ubuntu-latest, 22) | 22.23.3 | 824 | 823 | 1 | 0 / 0 |
| windows-recovery-state | 24.21.0 | 47 | 46 | 1 | 0 / 0 |
| test (macos-latest, 24) | 24.21.0 | 824 | 823 | 1 | 0 / 0 |
| windows-recovery-forwarding | 24.21.0 | 33 | 33 | 0 | 0 / 0 |
| test (ubuntu-latest, 24) | 24.22.0 | 824 | 823 | 1 | 0 / 0 |

四Unix还通过隔离安装包、pinned setup与doctor；Windows native组embedded setup/doctor成功。各组有重叠，不相加冒充独立测试数。本机Node24.19.0/26.10.0各824项，823pass/1Windows-only skip/0fail/cancel，比第一批新增100项。Windows native的5项、state的1项和锁组的5项跳过分别为POSIX权限/符号链接/FIFO/shell脚本合同，不冒充Windows已验这些行为；native恢复42项无跳过。真实SID/ACL检查与生产每操作8秒期限保持。

原生独审32/32、adversarial15/15、锁/CLI独审37/37。两真实owned C/D子进程死亡残留27项通过，原inode/owner保留转存quarantine；合成PID/probe不当作OS证据。旧63fba v3五writer fence143/143及独立264项通过：升级仅改变store.version/nativeIntents，其它原文件及身份/历史/pending保持；随后5旧writer拒写后，完整state/cache文件集合、字节、权限和hash保持。此范围不等于全部旧preflight或完整ST06。

默认安装launcher103/103：两worker各spawn1，pause/resume原PID/token，一q→formal→forwarded→admitted intent，五hash/receipt一致；fake持久输入及POST各1、重复0，准确CLI正常stop后两PID confirmed-dead，无所属锁残留。88/88 tar内容+mode匹配installed，完整before/after manifest相等，入口30次采样全755、watch0。

保留包315900bytes/解包1016381bytes/88files，SHA b8ad8a39a6a01dac1d41a7ea6bb6a61c953d51b2bc40624c6efe9126e357169d，86×0644+2×0755，61runtime逐Git一致。文档快照与CI临时315896bytes/后续收口包不同，不能混称同RC。package-smoke只核外置state/cache和安装目录项目，完整内容/权限由额外launcher证明。

[本机v1](../native-recovery-20261020-v1/README.md)与[首次失败v2](../native-recovery-20261020-v2/README.md)保留阶段事实。首次Windows42/36pass/6fail：5fixture规范路径/项目ID错误仅修测试；第6在首个ACL setup约8080.9ms失败，具体原因仍未确证，新增独立只读WindowsPowerShell元数据初始化实测3333ms，生产期限不放宽。首轮launcher77断言后EACCES，原工具调用确认是审查记录脚本递归移除共享fixture执行权限；原失败和两ownedworker正常stop保留，同tgz新prefix103通过，未原地修权限抹失败。其它审查先红覆盖foreign client、outcome/inbox CAS、signed wrapper和CLI scope/output边界。

用法见[原生与锁恢复](../../docs/NATIVE-RECOVERY.md)和[设计](../../docs/NATIVE-RECOVERY-DESIGN.md)。v4保存实际原prompt完整摘要及来源；未知只核原输入，Kimi/OpenCode V1提供完整persisted user证明。默认evidence只读store、零native/ledger；Kimi主动查询需显式允许加载。停后确死owner修复只补原receipt与匹配pending，保留cursor/其它字段，不重发/自动resume。

C/D须原先paused、全空间offline、仅ESRCH确死，独立R和同卷quarantine保留证据；R不约束普通writer，目录rename不宣称portable CAS。worker/未知scheduled token退休、V2/Codex强未知恢复保持needs-review，ZCode仍tool-pull。ST05整体进行中；ST06完整迁移/允许回退、连续真实项目、RC待后续，stable仍v0.2.0。

本批仅隔离embedded、fake loopback、owned children和平台CI，没有真实模型、SSH或既有用户服务/远端升级。历史真实多机通信实测独立保留。PR仍OPEN，未merge/tag或发布新stable。
