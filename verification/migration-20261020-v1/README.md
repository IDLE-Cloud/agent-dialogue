# 固定安装交接：首轮平台失败快照

本快照保留a2653bdb414598953326c69470b63fea54a5f89d的实际结果，不是最终平台验收。64运行文件标准摘要87f3da3cde3db2e12859f633e4464f6e11fe6d3382357af3159e5fea9d802e8d；具体数值见[metrics.json](metrics.json)。

Node24.19.0与26.10.0各917项，915pass、2Windows-only skip、0fail/cancel。隔离installed prefix实证135/135：旧1dd/c44等价runtime的两个worker经旧CLI正常stop，schema3→4后可以在未启用前恢复完整原store字节；第二次升级accept后才启动两个新token worker。1q、1formal、1admitted native intent与持久fake POST1次，重复0；四owned PID均正常stop并再次confirmed-dead。62次入口mode采样全755，package watch0；64runtime逐Git、93tar内容+mode与installed前后相同。

实际保留包349272bytes、1136650unpacked、93files（91×0644+2×0755），SHA20586f7c48f16982cff3ebd878c2a735100c0be24920ac6b72f9bce2cab27ad2。该包不是RC，文档与后续修复快照不同，不把后来修正倒填本包结果。独立追加清理utility曾因stdin argv为“-”导致旧CLI import错误，改用实际保存的mjs后复核四PID全dead；主135验收本身未因此失败。

[首次12组CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39439900151)出现平台失败：Ubuntu22/24的actual Node identity合同被safeInfo owner/writebits分支拒绝，原日志缺少准确stat，不能猜具体是哪一项；后续CI会输出原toolcache元数据，并验证只复制本job自有Node artifact、不修共享toolcache。Windows files58/35pass/17fail/6skip，transaction15/1pass/14fail，handoff16/1pass/15fail；首要阻断为currentSID owner gate，fixture新建state/dialogue及node/store/DB未全部显式按预定owner配置。修复仅允许准确新建fixture路径，不放宽生产权限或8秒期限；下一实际日志还需证明owner来源。

审查同时发现一项生产缺口：严格C/D的新owner.json仅继承ACL，而迁移要求准确当前SID；同步后同bytes替换owner inode也能触达callback并被删掉。新增独立3合同在本机2pass/1fail，原红保留。后续候选须只provision本次独占新owner并在callback前固定FD/path/完整bytes身份，属于运行代码改变，不能沿用本包135/摘要冒称修后已验。

本轮另保留未知C计划、发布后程序漂移、journal/store双端前像、首次foreign journal、Rowner、rollback中断verify与0644候选重试的先红修正。缺模块API红与fixture漏lifecycleProtocol分开，不算同类生产失败。完整raw日志仅存私有证据，公开材料不含node私钥、正文、session/token或私有连接。

操作见[迁移指南](../../docs/MIGRATION-OPERATIONS.md)和[设计](../../docs/MIGRATION-DESIGN.md)。同机同用户同state/backend/cache、持续offline和准确旧进程退出不可省；既有pending/unknown、新增历史/作用或accept后不得自动回退。Windows合同与Mac installed worker分别记账，不外推为已有Windows/VPS/RSI部署已迁移。当前ST06首片尚待最终候选及平台收口，stable仍v0.2.0，未merge/tag/Release。
