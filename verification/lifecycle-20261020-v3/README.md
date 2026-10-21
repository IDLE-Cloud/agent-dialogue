# ST-04 runtime 原子发布修正验收

前两轮记录分别保留[首轮生命周期本机实现](../lifecycle-20261019-v1/README.md)和[控制 store 快照修正](../lifecycle-20261020-v2/README.md)。随后 Linux Node24 CI629项出现1失败：`startBridge` 等待 worker ready 时，runtime 的 lstat→open 之间合法 rename 被误报为 `WORKER_OWNER_UNVERIFIED`。完整 job 日志私有保存；不能将本机通过或另一平台通过外推为该失败已消失。

`readRuntime` 现在也固定实际打开的 fd，有界读取并验证同 fd 的 regular-file、size/mtime、UTF-8、JSON/schema。POSIX NOFOLLOW/NONBLOCK、Windows 无 NOFOLLOW 时的身份匹配与最多16次重试保持。初始缺失与已记录但损坏/消失的 owner 证据仍区分，未知 owner 不会变成可重新启动的 fresh runtime。

新增三项黑盒合同经 `bridgeStatus` 观察：80个完整 runtime 原子发布与16×40读者并发、实际原地改写拒绝，以及 missing/格式损坏/UTF-8/超限/非普通/链接的区别。旧实现中16读者均错误报告 invalid，先红结果保留。修正后 runtime/所属真实子进程/CLI 聚焦15项通过；独立安全审查无阻塞。完整双版本、包、压力测试与平台状态以 [metrics.json](metrics.json)和对应提交的 CI 为准。

全部使用私有隔离 fixture 和 loopback 服务，没有真实模型、正式原生服务或远端变更。Windows job 包含新的 store/runtime 合同，仍需实际平台验收。暂停不取消已受理模型执行，旧安装 worker 不自动接管，未知 pending/锁不清理。ST-05、ST-06、实际项目试用及 RC 后续完成；本报告不是整个项目或新稳定 Release 已交付的声明。

后续平台结果：该实现四组Unix均成功；Windows322项为314pass/2fail/1cancel/5skip，两个压力publisher因共享读取下EPERM替换失败，另MCP总测试预算15秒取消。实际Windows失败、修正及恢复提交竞态的补充回归见[后续记录](../lifecycle-20261020-v4/README.md)。本快照不改写为Windows已通过。
