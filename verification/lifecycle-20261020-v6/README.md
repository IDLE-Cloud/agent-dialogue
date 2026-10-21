# ST-04 最终验收：保留绑定的暂停、恢复与停止

**ST-04 已完成。** 验收实现为 `fbca2f12af442e3f145edd2eb6281fc65d2ac4c6`；[五组CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39294916371)全部通过。后续收口仅更新文档和报告，运行文件摘要保持。使用入口为[生命周期指南](../../docs/LIFECYCLE.md)，当前范围见[状态页](../../docs/STATUS.md)。这次完成不等于整个v0.3稳定化计划已完成，稳定Release仍为v0.2.0。

| 验证 | 实际结果 |
|---|---|
| 本机Node24.19.0、Node26.10.0 | 各644项，643通过、1项Windows专用跳过、0失败/取消 |
| Linux Node22/24/26、macOS Node24 CI | 四组各644项，643通过、1项平台跳过；test/package/setup/doctor成功 |
| Windows Node24.21.0原生CI | 334项，329通过、5项平台跳过、0失败/取消；实际SID/ACL与embedded setup/doctor成功 |
| 新增合同 | 76项：59 lifecycle、4 store、3 runtime、10 atomic；复用预检基线568项 |
| 实际旧writer隔离 | 旧0aa51db→固定fbca源码，43/43断言；5/5旧writer副作用前拒绝v2，完整身份、账本及state字节/模式保持 |
| 实际安装包默认launcher | 固定fbca、Node24、40/40；带空格prefix、任意cwd、外置state/cache，真实默认detached launcher |
| 投递与清理 | pause零POST；resume同PID/token、一次fakePOST/一个回执前落盘输入/零重复；两个所属worker正常stop后confirmed-dead，无所属锁残留 |
| 独立审查 | 锁顺序、room CAS、MCP scope、快照、精确身份、包内容和公开隐私审查READY，无本批阻塞项 |

安装补验保留的tgz为 **271308 bytes**，SHA-256为 `4ce5aec4db1945550778f6da148db54ebedd409fafa8c37d60a8e13e92bfc982`；解包854473字节、76文件，逐项内容严格等于固定fbca源码。tar模式74×0644、2×0755；运行后完整程序字节和模式保持。该hash仅指实际保留的验收tgz，不宣称它与其它tarball字节相同，也不是已发行RC。收口文档会改变包字节，固定发行资产在ST-09另行完成。

53个运行文件的确定性摘要为 `f3d499ec122289d6e5f31835bdd153423d92b3040b2d65eb9205f91f69030f44`，格式及完整计数见 [metrics.json](metrics.json)。私有目录保留源码archive、逐文件hash、准确worker owner、state前后清单、模型外的fixture输入及全部原始日志；这些内容没有进入公开仓库或安装包。

本轮审查与实际失败促成了修正：恢复最终同C重查room pins，原生查询不占C，所有直接入口遵守D门禁；控制/runtime读取使用安全固定fd快照；Windows共享拒绝只对同一不可变候选有界重试；精确BigInt身份区分大inode并保留真实hardlink拒绝。原Windows日志未采raw IDs，现场精度碰撞仍是日志和确定性回归支持的推断。先红后绿、Node24本机失败、Linux CI失败、Windows两轮失败和所有中间计数分别保留，可从[上一阶段](../lifecycle-20261020-v5/README.md)追溯。

验收边界：本轮使用受控子进程和loopback假原生服务，**没有模型、真实harness/SSH调用或远端部署变更**。Windows CI合同不替代每种桌面或多机的模型实测；Mac安装包默认launcher不外推Windows实际Task Scheduler启动。跨prefix旧worker仍不自动接管，unknown/pending不清除，暂停不取消已受理模型执行。历史模块的精确身份核查、ST-05安全对账与残留恢复、ST-06完整升级回退、连续真实项目试用和RC仍须按原计划完成；没有合并、tag或新Release。
