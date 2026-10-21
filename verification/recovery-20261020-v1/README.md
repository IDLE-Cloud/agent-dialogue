# ST-05第一批：本机来源与对账验收

本快照固定实现提交 `0f18966924f67b90a6df1d2d5a1019a857189644`。ST-05仍进行中，[平台CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39357388203)在本快照时尚未结束，不将本机结果写成Windows已通过。后续结果另存新版本，本报告保持阶段事实。

本批实现显式离线v3、准确q→formal→m持久来源、MCP固定q与单次追加、完整有界同ID扫描，以及paused且准确owner停止并confirmed-dead后的outgoing receipt修复。操作见[对账指南](../../docs/RECOVERY.md)，顺序与中断合同见[实施设计](../../docs/RECOVERY-DESIGN.md)。缺来源、无证据、多候选、扫描不完整或远端结果未知都保留needs-review；不重新发送、不自动resume、不推进cursor、不删除锁。

| 验证 | 实际结果 | 适用边界 |
|---|---|---|
| macOS Node24.19.0 | 724 total / 723 pass / 0 fail / 0 cancel / 1 skip | 跳过Windows专用合同 |
| macOS Node26.10.0 | 724 total / 723 pass / 0 fail / 0 cancel / 1 skip | 与Node24同一运行源码 |
| 新增合同 | 80：schema15、evidence5、forwarding3、runtime15、MCP18、submissions7、nodes15、CLI2 | embedded、合成metadata/owner probes，不是模型实测 |
| 安装包smoke | 两个Node版本均通过；82文件 | 独立prefix、任意cwd、外部state/cache、已安装v2/v3升级及重复检查、只读inspect与viewer |
| 实际旧writer fence | 138/138；真实旧5ea6c43的5种入口拒绝v3 | 全state/cache字节与模式保持；只证明受测入口，不泛化所有命令preflight |
| 安装包默认launcher | 84/84；两个实际worker，各spawn1，额外start复用 | macOS；没有注入launcher；非Windows生产launcher实测 |
| 暂停→排队→恢复 | 暂停时仅1条q、零POST；恢复后1条formal、1条forwardings.forwarded | 全q/event/dispatch/hash/route关联一致 |
| 受控原生投递与清理 | POST1、回执前持久fake input1、重复0；两worker正常CLI stop且confirmed-dead | 自有OpenCode V2 loopback接口，不调用真实harness或模型 |

独立审查先红修正同ID候选漏检、旧MCP跨schema、queued reply parent证据和remote确认降级；runtime终止error与缺launch version分别有先红回归。另有完整UTF-8 16MiB发布边界和MCP准备越限零append合同。checkpoint提交后、runtime后像发布后的中断均能重试，原cursor、native pending、其它receipts和owner字段保留。真实进程死亡留下锁的处理仍需独立合同，测试finally释放不替代它。

57个运行文件与固定提交逐文件一致，标准摘要为 `56f96305f7234e922fd277bb402210b01e978e2f50bc40652d071fcb1093c94d`。算法是按路径排序的`{path,sha256}`数组，UTF-8 compact JSON、无末尾换行，再取SHA256。

实际保留并安装的候选包为82文件、压缩292648 bytes、展开932988 bytes，SHA256 `b95c8c1c2a6b4e640d3561e9e2c73b93435b2703d48308dab2511a9557324859`，模式80×0644＋2×0755。它来自冻结工作树：运行内容后核与上述提交一致，文档快照不同；不声称它与CI生成包字节一致，也不是固定RC发行资产。两次package smoke的文档快照不同，压缩大小分别290023/290250 bytes，不与保留候选包混用。

本批没有SSH、远端部署、真实harness API或模型调用，没有改用户现有服务/聊天。稳定版仍v0.2.0，未merge/tag/Release；通用native pending操作者恢复、真实残留锁、ST-06迁移/回退、连续跨机项目试用和RC继续待完成。公开计数和封闭字段见[metrics.json](metrics.json)，私有完整记录与失败日志单独保留。
