# 第三轮平台结果与测试分片修正

[CI39445922619](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39445922619) 对应15f264468134211af5c6f49a13ade492426bf392，十五组全部终态：13success、1failure、1cancelled。本轮未通过完整平台验收，不能把此前本机与真实安装成功当作补齐Windows结果。运行源码仍为ecbe720，64文件标准SHA为f8932727b87c6e5554624fb4264a28d8965faa7b486de87fba325afacbec738d。精确Node、原始日志hash和后续计划见[metrics.json](metrics.json)。

| 组 | 结论 | tests | pass | skip | fail / cancel |
|---|---|---:|---:|---:|---:|
| test (macos-latest, 24) | success | 921 | 919 | 2 | 0 / 0 |
| test (ubuntu-latest, 22) | success | 921 | 919 | 2 | 0 / 0 |
| test (ubuntu-latest, 24) | success | 921 | 919 | 2 | 0 / 0 |
| test (ubuntu-latest, 26) | success | 921 | 919 | 2 | 0 / 0 |
| windows-lock-recovery | success | 50 | 45 | 5 | 0 / 0 |
| windows-migration-files | success | 62 | 56 | 6 | 0 / 0 |
| windows-migration-handoff (checkpoints) | cancelled | 8 | 7 | 0 | 0 / 1 |
| windows-migration-handoff (preimages) | success | 8 | 8 | 0 | 0 / 0 |
| windows-migration-transaction (publication) | success | 6 | 6 | 0 | 0 / 0 |
| windows-migration-transaction (readiness) | failure | 5 | 4 | 0 | 0 / 1 |
| windows-migration-transaction (recovery) | success | 4 | 4 | 0 | 0 / 0 |
| windows-native | success | 342 | 337 | 5 | 0 / 0 |
| windows-native-recovery | success | 42 | 42 | 0 | 0 / 0 |
| windows-recovery-forwarding | success | 33 | 33 | 0 | 0 / 0 |
| windows-recovery-state | success | 47 | 46 | 1 | 0 / 0 |

四Unix完整回归各921/919pass/2Windows-only skip，包smoke、pinned setup/doctor通过。表中Ubuntu组的22/24/26表示Node版本，OS均为ubuntu-latest。Windows native的embedded setup/doctor亦通过。分组存在重叠，不能相加冒充独立用例数。

readiness五项中四项通过；原pending/nativePending/outgoingPending三字段合并用例于900032.36ms触发900秒整体测试限制。日志缺少字段/阶段计时，不能认定停在哪个字段或仅仅是性能问题。checkpoints分片八项中七项通过，check-run注释明确35分钟作业上限；最后rollback-store-published只读验证没有positive完成事件，file-level pending取消不能视为第八项通过。31个计划合同中29个不同具名用例获通过，没有重复覆盖。

后续[5d0ffb5候选](https://github.com/IDLE-Cloud/agent-dialogue/commit/5d0ffb58b1db6c9546bcbc81683df45c02662a71)只修改测试与CI：三字段各自成为具名top-level test、分别配置Windows作业，并记录setup/prepare/apply/negative-rollback前后耗时；中断验证另分片。[新CI39452641171](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39452641171)的19作业为4Unix+15Windows，transaction4/1/1/1/6/4、handoff8/4/4。本机实际pattern运行确认33不同用例各选中一次，Node24.19.0/26.10.0完整回归各923/921pass/2平台skip/零失败取消。计数增加两项来自拆开原有字段循环，不代表新增功能或语义覆盖。本快照时新CI仍待验。

每项原断言、900秒测试预算、生产ACL8秒和接收因果race5秒均保留；900秒仅transaction/handoff整体fixture，Windows作业35分钟、Unix作业10分钟，不能当作生产响应时间承诺。下一轮仍需真实Windows结果。

本轮blocked-query用例11800.14ms通过，fixture-ready8204/native-blocked9782/receiver-completed10041ms，接收在原生查询阻塞时约259ms完成。新结果不能倒推前两轮20秒取消发生的确切阶段。state首CLI4121.47ms通过，只读metadata初始化不等于证明旧8347.9ms错误的根因。实际SID/ACL核验没有被禁用；只配置本次独占新fixture，不自动修已有源权限。

实际安装证据沿用[第二快照](../migration-20261020-v2/README.md)的准确ecbe包：macOS默认launcher135/135、四worker正常退出并确死、schema3→4→原bytes rollback、第二bundle accept后才激活新token、持久fake POST1/重复0；93文件逐Git内容+mode等于15f。该实证使用合成OpenCode V2，不是Windows真实安装迁移或模型试用。原[首轮](../migration-20261020-v1/README.md)与[第二轮](../migration-20261020-v2/README.md)失败完整保留。

操作见[迁移指南](../../docs/MIGRATION-OPERATIONS.md)。选定范围为同机同用户/同state/backend/cache/固定新prefix与同卷私有bundle，必须持续offline；R/C不是所有旧writer的fence。rollback只在激活前准确完整后像匹配时恢复唯一原store，已有unknown/pending或accept永久关闭资格。ST06首片仍待完整平台验收，ST06整体、ST05剩余退休/强unknown恢复、连续真实项目试用与RC未完成；stable仍v0.2.0，无merge/tag/Release，未迁移既有Windows/VPS/RSI/原聊天。

后续观察：第四轮5d0ffb5的Ubuntu/Node26.12.0全量报告923/920pass/1fail/2skip。唯一失败为POSIX ZCode worker测试的after清理，生产detach命令返回`kill ESRCH`；package/setup/doctor因全量失败未执行。原始日志SHA256为b176789f9870f5529c4888e62f6619aacd4d04f41d341e11bc9ab2ee205856b5。该次失败与第三轮两个未完成场景分开记账；其他job继续收集，不用旧结果冒充本轮通过。正在核查owned-live检查后进程退出的停止竞态，若修改运行代码必须重新生成runtime摘要、保留包和真实安装证据。
