# ST-04 Windows 原子发布与恢复提交修正

本记录继承[前轮快照](../lifecycle-20261020-v3/README.md)。CI39287999536 对该源码的四组Unix通过，Windows为322项、314pass、2fail、1cancel、5skip；两个并发快照publisher出现EPERM rename，MCP持dispatch至tool-read提交的15秒总测试预算取消。原始日志与先前成功均保留，不因一平台成功覆盖另一平台失败。

控制 store 和 worker runtime 现共用不可变文件发布 helper：仅Windows EPERM/EACCES在1500毫秒、80次上限内重试同一个准确source/destination。每次核对文件身份和内容元数据，源或目标变化即拒绝。不删除目标、不重建候选、不改ACL，不重新发送消息或prompt；发布失败保留候选和旧目标。实际control锁或single-writer范围跨整个await。八项helper合同及真实withStore失败保留合同先红后绿；压力publisher错误即时收集、仍明确抛出。

另外用确定性native查询gate先红复现peer在resume核对期间detach仍被放行；最终enable的同一个短control事务现重查room active/id/revision/node pins。它不取peer dispatch或查询peer native，control释放后peer仍可正常独立退出。

Windows测试只依据实测12.6至20.4秒成本调整四项总预算为30/60秒，POSIX预算、真实ACL、全部断言/skip和生产8秒单次权限deadline保持。该调整不替代新Windows实际验收。

最新双版本完整测试、包、独立审查与平台结果见 [metrics.json](metrics.json)及本次提交的CI。43项旧实际writer fence验证曾在0aa51db→527001d私有合成空间通过，源码/身份/账本证据保留；它不是ST-06完整迁移/回退矩阵。所有本机验证无真实模型、原生服务、SSH或用户state变更；ST-05/06及RC仍后续完成。
