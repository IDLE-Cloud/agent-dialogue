# 同机固定安装交接：首批验收

固定实现[f2edb4a](https://github.com/IDLE-Cloud/agent-dialogue/commit/f2edb4a0bb9788f660c8c90fe97242c7cc557ebc)通过[十九组平台CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39459128207)、独立审查、本机回归和重新打包后的实际安装交接。64个运行文件标准SHA256为`5e8450edfc3bde20bcc8f6b017a8489c13356c85f60660475ff10c9314cd522d`。精确版本、原始日志摘要和限制见[metrics.json](metrics.json)，实际操作见[迁移指南](../../docs/MIGRATION-OPERATIONS.md)。

本批交付同机、同用户、同state/backend/cache、独立固定新prefix的`plan/prepare/apply/verify/accept/rollback`。完整state用私有manifest与hash blobs备份，SQLite只核副本；确定性schema2/3/4→4保留身份、room和旧记录。回退只恢复唯一`store.json`的原始字节，必须处于激活前维护窗口，且源完整后像、备份、journal、安装、Node和owner仍精确匹配。初始pending/unknown或accept永久关闭回退资格。

## 平台检查

| 组 | 实际Node | tests | pass | skip | fail / cancel |
|---|---|---:|---:|---:|---:|
| test (macos-latest, 24) | v24.21.0 | 933 | 930 | 3 | 0 / 0 |
| test (ubuntu-latest, 22) | v22.23.3 | 933 | 930 | 3 | 0 / 0 |
| test (ubuntu-latest, 24) | v24.22.0 | 933 | 930 | 3 | 0 / 0 |
| test (ubuntu-latest, 26) | v26.12.0 | 933 | 930 | 3 | 0 / 0 |
| windows-lock-recovery | v24.22.0 | 52 | 47 | 5 | 0 / 0 |
| windows-migration-files | v24.21.0 | 62 | 56 | 6 | 0 / 0 |
| windows-migration-handoff (interrupted-images) | v24.22.0 | 4 | 4 | 0 | 0 / 0 |
| windows-migration-handoff (preimages) | v24.21.0 | 8 | 8 | 0 | 0 / 0 |
| windows-migration-handoff (schema-and-owners) | v24.22.0 | 4 | 4 | 0 | 0 / 0 |
| windows-migration-transaction (publication) | v24.22.0 | 6 | 6 | 0 | 0 / 0 |
| windows-migration-transaction (readiness) | v24.21.0 | 4 | 4 | 0 | 0 / 0 |
| windows-migration-transaction (recovery) | v24.21.0 | 4 | 4 | 0 | 0 / 0 |
| windows-migration-transaction (runtime-native-pending) | v24.21.0 | 1 | 1 | 0 | 0 / 0 |
| windows-migration-transaction (runtime-outgoing-pending) | v24.22.0 | 1 | 1 | 0 | 0 / 0 |
| windows-migration-transaction (runtime-pending) | v24.21.0 | 1 | 1 | 0 | 0 / 0 |
| windows-native | v24.22.0 | 350 | 341 | 9 | 0 / 0 |
| windows-native-recovery | v24.21.0 | 42 | 42 | 0 | 0 / 0 |
| windows-recovery-forwarding | v24.21.0 | 33 | 33 | 0 | 0 / 0 |
| windows-recovery-state | v24.21.0 | 47 | 46 | 1 | 0 / 0 |

所有job均success，零fail/cancel。四Unix还通过93文件包smoke、pinned setup和doctor；各CI包字节数另按原始日志记录，不能由macOS保留包推定。Windows native的embedded setup/doctor成功。Ubuntu组的22/24/26指Node版本，OS均为ubuntu-latest。各组存在重叠，不能相加冒充独立用例数；POSIX范围跳过仍不算Windows已经验证。实际SID/ACL检查没有被禁用，过滤分片的未匹配场景不算平台skip。

本机Node24.19.0与26.10.0各933项、930pass/3平台skip/零失败取消。相对824基线增加109个顶层检查计数，其中2项来自把既有三字段循环拆开。transaction4/1/1/1/6/4、handoff8/4/4共33个不同迁移场景，在实际Windows结果中各通过一次。

## 实际安装交接

本次重新执行135/135，不借用旧包结果。准确旧1dd/c44等价安装启动两个默认worker，用所属旧CLI正常pause/stop并确死；新安装在同state/backend/cache备份后schema3→4、verify、准确原bytes rollback。第二bundle再apply/verify/accept，先永久关闭回退才启动两个新token worker。node、binding、room pins与旧runtime保留；暂停时零POST，恢复后q1→formal1→forwarded1→admitted native intent1，持久fake输入1、POST1、重复0。

旧2＋新2均用所属CLI正常stop，另行二次确认4/4 PID已不存在；没有由runner直接发信号清理。完整93文件内容、模式与固定Git及安装前后/结束后相同，62次CLI entry采样全0755、package watch0。实际保留tgz为350223字节、1140312字节unpacked、93文件（91×0644＋2×0755），SHA256为`2cf10714b85e7a93ff6390d614c2eff40b03f9fcb7918d732ba6a1974521025e`。文档收口包另外记账，不混称同字节RC。

该实证使用macOS实际安装、默认detached launcher、OS进程归属、embedded账本和自有synthetic OpenCode V2；不执行模型，不等于Windows实际安装launcher或完整ST06证明。此前a265、ecbe、a2ee三轮实际安装各135及各自包均独立保留，没有把不同runtime结果合并成当前来源。

## 保留的失败与修正

| 历史CI | jobs | success | failure | cancelled |
|---|---:|---:|---:|---:|
| [a265](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39439900151) | 12 | 6 | 6 | 0 |
| [ecbe](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39442467557) | 12 | 7 | 3 | 2 |
| [15f](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39445922619) | 15 | 13 | 1 | 1 |
| [5d](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39452641171) | 19 | 16 | 3 | 0 |
| [a2ee](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39454755108) | 19 | 17 | 2 | 0 |

[v1](../migration-20261020-v1/README.md)、[v2](../migration-20261020-v2/README.md)、[v3](../migration-20261020-v3/README.md)保留原快照，后两轮完整终态另见metrics。修正包括新fixture与产品内部新owner的明确所有权、C/D原inode/rawbytes入口和释放校验、候选两端BigInt发布基准、先close WAL源DB再清理，以及先release/drain原生阻塞操作再清理fixture。旧toolcache mode记录缺失不倒填；新Unix job核私有0755 Node副本的源双stat和两端hash，不修改共享cache。三字段独立分片和阶段计时没有减少断言、跳过权限或放宽生产期限。

真实Ubuntu26曾在ZCode worker detach清理中返回`kill ESRCH`。窄修只在准确owned-live后SIGTERM遇ESRCH时接受目标已退出；EPERM/EIO仍抛，unknown/dead/remote不signal，Windows继续合作退出。确定性DI红6/4pass1fail1skip明确与真实OS失败分开，修后双Node定向7/6pass1skip；原生聊天、peer、room和两份runtime字节保持。

早先Windows首fixture的generic ACL执行失败，以及并发start的provisioning-not-confirmed，底层原因仍未证实。后者已通过执行/解析/私有ACL校验，可能是protected或owner确认不符；旧日志未记录两个具体值。本轮只为该Error加两个布尔值，原条件/message/拒绝不变。新增DI红是字段缺失，原本就已拒绝，不把它说成门禁绕过。

lock/files测试首root权限操作使用真实相同execFile与8000ms，仅诊断固定op/elapsed/受限code/signal/killed；成功stdout仍交原validator，失败仍拒绝，无retry。CI写入初始化只操作新UUID目录和CreateNew空文件，成功后准确删除文件与非递归空目录。2分钟只属于该setup，不改产品8秒。后续绿不能证明旧原因为coldstart或已被初始化修复。900秒只属于transaction/handoff整体fixture，Windowsjob35分钟、Unix10分钟；接收因果race仍5秒，这些不是产品响应时间承诺。

## 验收边界

MG首批选定范围完成，ST06整体仍进行中。必须用准确旧安装正常退出，所有CLI/MCP/SSH/worker写入者持续offline；R/C是行政互斥，不是所有旧writer的fence。只接受固定兼容来源与同卷私有bundle，不整树restore、不跨机复制私钥、不转换backend或自动修改服务/MCP/SSH路径。Windows已有源必须currentSID持有，Admins/SYSTEM所有权仍needs-review；新fixture配置不是已有生产空间的修复指令。

ST05整体的worker/未决scheduled token退休、V2/Codex强unknown恢复、ST08连续真实项目试用、Windows实际安装迁移与性能观察、固定RC仍待后续。stable仍v0.2.0，PR保持OPEN，未merge/tag/Release。本批没有真实harness模型回合、SSH或既有Windows/VPS/RSI/原聊天迁移。

文档收口补记：仅更新说明和MG子项状态，64运行文件的内容与模式仍逐Git等于已验f2ed，摘要保持5e8450edfc3bde20bcc8f6b017a8489c13356c85f60660475ff10c9314cd522d。Node24.19.0再次完成文档包smoke，93文件/351338字节；该临时归档已由测试清理，不冒充实际135所用350223字节/2cf10714…保留包。没有因文档收口重跑模型或worker；来源比对与包smoke原始日志摘要见metrics的documentationClosing。
