# ST-04 本机生命周期实现验收

本次实现保留准确 binding 的暂停、恢复与所属 worker 停止，并提供显式离线 v1→v2 控制 store 升级。它没有完成整个 v0.3 稳定化；操作入口和迁移限制见 [LIFECYCLE.md](../../docs/LIFECYCLE.md)。

本机全量 **626 项：625 通过、1 项 Windows 专用跳过、0 失败**，比预检基线新增 58 项生命周期合同。包含直接/remote/flush、native/drain、MCP inbox 的共同 dispatch 门禁、同进程/同游标恢复、并发单次启动、真实所属 worker 协作停止、另一 binding 不受影响，以及真实 loopback POST 在途时 pause 等待的边界。全部使用隔离 fixture；没有真实模型或远端变更。

独立审查发现并以失败测试复现后修复完整 room 身份恢复 CAS、MCP scope 变化、control 跨 native 查询等问题。损坏 owner、查询 unknown、启动结果未知、pending/outbox 未确认和残留锁均保持待核对，不清状态重发。完整失败与最终日志私有保存；公开文件只保留封闭计数与源码摘要。

本机包隔离 prefix 安装、任意 cwd、显式 v2 升级保留节点、inspect 保持 v2 store 字节等检查已通过，计数及摘要见 [metrics.json](metrics.json)。运行文件摘要范围为 bin/lib/config/web/package.json，格式在 JSON 内声明。平台 CI 在此本机快照时尚未完成；Windows 的真实 SID/ACL 与进程结果必须另查关联 PR 检查。

ST-05 分层对账/残留恢复、ST-06 固定版本升级/回退演练，以及真实项目试用和正式 RC 后续进行；本次没有合并、tag 或 Release，稳定版本仍为 v0.2.0。
