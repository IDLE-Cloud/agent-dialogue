# ST-05第一批最终验收：来源、固定请求与停止后对账

实现提交 `0f18966924f67b90a6df1d2d5a1019a857189644` 已通过[全部七组CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39357388203)。本报告收口ST-05第一批；整个ST-05仍进行中，通用native pending操作者恢复与真实残留锁处理尚未实现。稳定Release仍为v0.2.0，未merge/tag/Release。

## 已实现行为

- 显式 `state upgrade --offline --target 3` 启用本地控制v3，保留node、room、账本和旧pending；默认目标仍为v2。旧v1/v2 writer拒绝v3，操作者仍须静止所有写入者，不能据此在线覆盖安装或降级。
- 新queued请求保存准确q事件/hash、binding/revision、完整route hash、dispatch和正式frame关联；远端固定m/time/payload hash，与outbox双向关联。正文继续保留在原账本。
- MCP新请求先持久固定q，单次取得追加权；同requestKey与同内容重取原结果。结果未知时只做完整有界同ID扫描，不分配新q或再次append。
- `bridge reconcile ALIAS --submission q_UUID`仅用于paused、准确所属worker停止并confirmed-dead、matching stopped reservation、无所属worker锁和未决launch的场景。只补准确outgoing receipt并移除匹配pending；保留cursor、native pending、其它receipts及owner/error，不自动resume。
- 控制checkpoint和runtime后像分别提交；重试只接受保存的前像或后像，第三种状态拒绝。缺来源、缺证据、多候选、扫描不完整和remote-unconfirmed继续needs-review，不删除锁、不启动worker或模型。

使用步骤、返回原因与容量边界见[RECOVERY.md](../../docs/RECOVERY.md)；锁序及中断合同见[RECOVERY-DESIGN.md](../../docs/RECOVERY-DESIGN.md)。

## 实际测试与补充验收

| 环境/项目 | total | pass | fail / cancel | skip |
|---|---:|---:|---:|---:|
| 本机macOS Node24.19.0 | 724 | 723 | 0 / 0 | 1 Windows-only |
| 本机macOS Node26.10.0 | 724 | 723 | 0 / 0 | 1 Windows-only |
| Linux Node22.23.3 CI | 724 | 723 | 0 / 0 | 1 Windows-only |
| Linux Node24.21.0 CI | 724 | 723 | 0 / 0 | 1 Windows-only |
| Linux Node26.12.0 CI | 724 | 723 | 0 / 0 | 1 Windows-only |
| macOS Node24.21.0 CI | 724 | 723 | 0 / 0 | 1 Windows-only |
| Windows Node24.21.0 recovery-state | 47 | 46 | 0 / 0 | 1 POSIX-mode-only |
| Windows Node24.21.0 recovery-forwarding | 33 | 33 | 0 / 0 | 0 |
| Windows Node24.21.0 native | 334 | 329 | 0 / 0 | 5 POSIX专用 |
| 真实旧5ea→v3 writer fence | 138 | 138 | 0 / 0 | 0 |
| 已安装包默认production launcher | 84 | 84 | 0 / 0 | 0 |

新增80项合同：schema15、evidence5、forwarding3、runtime15、MCP18、submissions7、nodes15、CLI2。Windows三组使用实际SID/ACL；recovery-state唯一skip为chmod目录模式的POSIX断言，native的五项为POSIX PATH执行、mode与symlink断言。实际Windows ACL拒绝和私有路径检查没有跳过。三个Windows组耗时分别约740秒、555秒、1164秒；原生embedded setup/doctor成功，生产每操作8秒权限deadline保持。

四组Unix CI还均通过82文件安装包smoke、固定hcom setup和doctor；CI临时包压缩293433 bytes。该包检查实际安装后的v2/v3显式升级、重复升级、身份保持、inspect字节不变、全局入口、任意cwd、独立state/cache和viewer资产/API；不是仅从源码import验证。

真实旧writer验收从旧提交5ea6c43的Git代码构造v2私有embedded状态，经当前CLI显式升级到v3。保留node私有身份、签名room、旧未知outgoing/MCP preparing、runtime pending/native pending/receipts及有原q来源的append-started记录；五种旧入口均以准确schema错误拒写。完整state/cache文件内容、大小、模式和目录集合不变，受测入口审计到的网络/子进程/signal尝试为零。此结论只涵盖受测入口，不能泛化所有旧命令的preflight，也不是ST-06通用迁移回退。

默认launcher验收在macOS Node24实际安装包中启动两名owned workers，各spawn1，显式start复用原PID/token。暂停source后实际CLI排入q1、formal0、POST0；恢复后q1→formal1→forwardings.forwarded1，receiver在HTTP回执前持久fake input1，POST1/重复0。两个worker均正常CLI stop且精确confirmed-dead，绑定、room pins、cursor/receipts及来源保持，锁无残留。它使用自有OpenCode V2 loopback服务，不是Windows生产Task Scheduler或真实模型实测。

## 审查、失败历史与源码身份

独立审查先红修正：同ID的错误sender/坏候选被提前过滤、旧MCP跨schema继续追加、queued reply parent实际入账证据不足、missing-event重试降级已确认remote结果，以及terminal error/缺launch version的恢复门槛。控制store另有完整UTF-8含换行16MiB发布边界，MCP准备越限保留原store且零append；capacity guard ablation明确是隔离移除检查的反例，不冒充历史提交。

checkpoint提交后和runtime后像发布后的中断均有重试与字节幂等合同。owner live/unknown、nonce/pins变化、runtime第三种像、锁或scheduled descriptor出现时均拒绝继续。相关单元合同的PID探针是合成注入，OS进程归属与清理证据来自独立安装包默认launcher，不能互相混称。

57个运行文件在私有fence快照、实际安装包和Git提交逐一一致；标准摘要 `56f96305f7234e922fd277bb402210b01e978e2f50bc40652d071fcb1093c94d`。摘要算法为按POSIX路径排序的`{path,sha256}`数组，UTF-8 compact JSON、无末尾换行，再SHA256。收口仅修改文档和报告，不改变已验运行代码。

实际保留安装包为82文件、压缩292648 bytes、展开932988 bytes，SHA256 `b95c8c1c2a6b4e640d3561e9e2c73b93435b2703d48308dab2511a9557324859`，80×0644＋2×0755。它源自冻结工作树，运行内容后核与固定提交相同，文档快照不同；不声称与CI临时包字节一致，也不是固定RC资产。原[本机阶段v1](../recovery-20261020-v1/README.md)、所有red/green、先前成功/失败及私有完整日志保留。

## 后续门禁

下一批先明确native完整输入证据与历史renderer上下文，再设计有限残留锁计划与准确owner退休；不按文件年龄删除。worker锁与Windows迟到launch需要原token不可复用和任务instance证据，当前没有通用破锁命令。ST-06维护/备份/回退、连续跨机项目试用和RC继续按[稳定化计划](../../docs/V0.3-STABILIZATION-PLAN.md)推进。

本批未访问真实harness API、模型、SSH或用户远端部署，未改用户活动聊天/服务。本次合同与CI不能扩大为新一轮真实多机模型通信或所有桌面版本支持。封闭字段、各job身份及原始计数投影见[metrics.json](metrics.json)。
