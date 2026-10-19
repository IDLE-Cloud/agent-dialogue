# ST-01/02/03 本机实现验收

本记录对应当前入口、操作合同设计和统一 `inspect`，不是新一轮真实跨机/模型对话验收，也不是完整 v0.3 稳定化完成报告。来源基线、运行文件内容 hash 及封闭计数见 [metrics.json](metrics.json)。运行文件清单仅包含 bin/lib/config/web/package 元数据；完整私有日志留在本机，不含于安装包。

- 新增 28 项 inspect 模块合同、4 项 CLI 合同，先红后绿；本机全量 568 项，567 通过、1 项 Windows 专用跳过、0 失败。
- 隔离 prefix 的最终包 73 文件、246601 字节；从无关 cwd 运行，setup 前预检保持 state/cache 不存在，包本身不产生运行文件。
- 默认只读元数据、不打开 SQLite，不调用 hcom/harness/SSH；native 深查使用 fake adapter，Kimi 额外 cold-load flag、ZCode registration-only、未知状态及秘密过滤分别测试。
- 独立审查提出的 ingress preparing 漏报及超过检查上限误称损坏已有新增先红后绿回归；身份有界读取复用既有并发首次发布合同。
- 新模块/CLI 合同已加入 Windows native CI。此文件保存本机快照；各平台结果以关联 PR 的本次检查为准，不能把本机通过外推为 Windows 真实检查通过。

pause/resume、store v2 离线迁移、分层对账/残留锁恢复、升级/回退、实际项目连续跨机试用和 RC 仍待后续实施。新锁序只存在设计文件，没有改变现有消息运行路径。未调用真实模型/原生服务，未变更远端或正式聊天，未合并或发布。
