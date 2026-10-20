# 固定安装交接：修正候选本机与真实安装结果

候选ecbe7207d5b392f755e09cb30a41347dd276178e，64运行文件标准摘要f8932727b87c6e5554624fb4264a28d8965faa7b486de87fba325afacbec738d。Node24.19.0与26.10.0各921项，919pass、2Windows-only skip、0fail/cancel，比原824新增97合同。准确计数和证据摘要见[metrics.json](metrics.json)。

新隔离installed prefix再次135/135：准确旧1dd/c44-equivalent的2worker正常stop后，完整state私有blob备份、schema3→4、verify与准确原store bytes rollback；第二bundle再apply/verify/accept，只有accept后启动新2worker。同binding/node/room pins/旧runtime字节保留；单q→formal→nativeIntent admitted，持久fake POST1/重复0。新旧四PID用各自所属安装正常stop并二次confirmed-dead；62次entrymode全755、packagewatch0。64runtime及全部93tar内容/mode逐Git并与installed before/after匹配。fake loopback OpenCode V2不执行真实模型，不外推为Windows launcher或V2未知强恢复证明。

本次实际保留tgz350009bytes、1139728unpacked、93files（91×0644+2×0755），SHA fcb147988348fc5c097e05a91e76f8cce7a9fbbbf179405847bba906b74af4b8。原[a265失败快照](../migration-20261020-v1/README.md)、135成功旧包和全部red保留，不混用运行代码摘要或包快照。后续文档收口包也须单独计数，不冒称本tgz即RC。

运行修复只provision strict C/D本次独占新owner文件，callback前核原FD/path/inode/bytes，释放时同inode、单链接、前后BigInt字段、有界rawbytes与目录唯一owner才清理。entry同bytes换inode红3/2pass1fail及release红4/3pass1fail均保留，修后独审4/4。源码改变后已重跑新双Node、包与真实135，不套用首轮成功。

测试新state/dialogue/node/store/DB仅在首次快照前对准确本次新建对象设置Windows owner，产品不修已有源权限；既有Admin/SYSTEM owner空间按严格当前SID合同仍needs-review。Unix新CI实证Node22/24工具缓存mode0100777、owner为当前UID，Node26为0100755，故job对自己新Node副本核源双stat和两端hash、设置0755后使用，原共享toolcache不变。原失败轮没有stat，不把新轮数值倒称为旧轮直接证明。

[新12组CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39442467557)仍执行中；本快照已知ubuntu-latest上Node22.23.3/24.22.0/26.12.0三组各921/919pass/2skip且包93/350009、setup/doctor通过。macOS和八Windows必须待准确终态/raw才能报告，不能由上述Unix或本机外推。

操作见[迁移操作指南](../../docs/MIGRATION-OPERATIONS.md)。完整空间持续offline、准确旧安装退出、原source/catalog和same-volume bundle不可省；回退只在未accept、无初始unknown且完整维护像一致时恢复唯一store。新历史/作用后的回退、跨机私钥复制、backend转换或自动服务重写不支持。stable仍v0.2.0，未迁移用户既有Windows/VPS/RSI或真实聊天，未merge/tag/Release。

原a265轮随后12/12终态，6success/6failure；最后既有Windows native组342/336pass/0fail/1cancel/5skip，唯一取消为blocked-native-query合同的整体20秒期限。该期限包含两节点及多次实际ACL的fixture创建，不能把取消改称通过。后续test-only候选仅将Windows整体测试预算增至120秒并加阶段时长诊断；内部5秒接收race、接收必须在原生查询释放前完成的因果断言，以及生产8秒权限deadline均保持。运行64文件与ecbe不变，新平台实际执行另记。

本轮随后Windows files62/55pass/1fail/6skip，4个strict C/D身份合同全部通过；唯一WAL项失败为fixture在db.close hook之前rm源DB造成EBUSY，后续改用body的finally先关闭。Windows新目录owner实证为trusted Administrators组、不是当前SID，公开不展示机器SID。state组47/45pass/1fail/1skip，首CLI在8347.9ms返回统一ACL inspection failed；没有更细错误，不能确证timeout或冷启动原因。后续CI在该job先做独立只读SID/ACL元数据初始化，生产8秒操作保持fail-closed；原失败/raw不覆盖。

下一test-only CI按实际Windows私有文件核验成本拆为15个job：transaction按5/6/4合同三片，handoff按8/8两片，每job35分钟；新维护测试的Windows单test fixture预算900秒，正确性断言与生产8秒单操作不改。Node24真实跑五个name-pattern选中31项、31个不同合同，每项恰一次，非漏跑或将过滤项冒称平台跳过；实际Windows结果另记。

预算范围补充：上述900秒仅适用于transaction/adversarial与handoff两类整体fixture；migration-files仍300秒、strict-lock-owner仍120秒，不是所有维护测试统一增加期限。

术语补充：35分钟是Windows job预算，Unix matrix仍10分钟。“CI执行中”及metrics的statusAtSnapshot用于概括active jobs，不是GitHub overall-run状态逐字引用；邻近原snapshot003在3completed/8active/1queued时，API整体仍queued。ecbe的native组随后也以342/336pass/0fail/1cancel/5skip结束，同一20秒整体期限取消（20006.7482ms），setup/doctor跳过；这份候选没有native通过结论，第三轮结果另记。

第二轮最终12job全终态：7success/3failure/2cancelled。transaction只报告12项/8pass/4cancel（不是完整15），其中三项先触及300秒test期限，另有file-level pending取消；handoff只报告14项/13pass/1cancel（不是完整16）。两job的check-run annotation均直接说明超出35m0s，由CI上限终止，观察者没有cancel。原不完整汇总和raw保留，第三轮分片及900秒整体fixture预算的实际平台结果独立记录。
