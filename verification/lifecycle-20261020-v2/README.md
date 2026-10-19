# ST-04 补充运行时失败后的修正验收

本记录继承 [首轮快照](../lifecycle-20261019-v1/README.md)，保留其 Node26 成功与随后 Node24 的失败事实。初次 Node24.19.0 全量626项为624pass/1fail/1平台skip：同 binding 恢复后 PID 改变。并发回归用16读者与80个不可变 store 原子发布先红复现了 pathname 比对误判，不能用偶然再跑成功消除这一失败。

读取现在固定打开的文件描述符、有界读取，校验同一 fd 的 size/mtime、严格 UTF-8 和 schema；正常 rename 后旧 inode 仍是合法快照。新测试另受控原地改写，确认仍拒绝损坏。NOFOLLOW/NONBLOCK、Windows 缺 NOFOLLOW 时的 lstat/fd 身份门禁、安全重试上限、ACL 与生产 deadline 保留。实际 dispatch 仍在 D→C 内重新核对 enabled/完整身份。

修正后 Node24.19.0 与 Node26.10.0 在同一物理 Mac 的完整测试各 **629项，628通过、1项Windows专用跳过、0失败**。三项新增 store 合同使相对预检基线的增量为61项（58生命周期+3安全快照）。所属 worker fixture 增加有限 stderr/退出状态诊断，便于未来失败追踪。独立安全审查无阻塞。

包仍执行隔离安装、任意cwd、显式v2升级保留node、inspect保留store字节等检查。版本、运行源码摘要、包计数与平台进度见 [metrics.json](metrics.json)。Windows新增完整store合同，含真实SID/ACL权限核验；平台CI在本机快照时尚未完成，不能把本机两版本当作Windows/Linux验收。

本次无真实模型、原生服务或远端变更。ST-05 对账和 ST-06 通用迁移/回退等后续未实施；旧记录/锁/未知结果继续保留，未合并或发版。
