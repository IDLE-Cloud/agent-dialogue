# ST-04 精确文件身份修正

本记录接续[前轮 Windows 发布修正](../lifecycle-20261020-v4/README.md)。实现提交 `b692554e928efb5e96d455a6e8f7337340daa8f5` 的[实际 CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39291657435)四组 Unix 通过；Windows 为 **332 项、324 通过、3 失败、0 取消、5 项平台跳过**。三项都在发布前的 dev/ino 同文件检查被拒绝，后续 embedded setup/doctor 因前步失败跳过。

旧 helper 的 Number 身份比较可被确定性回归复现：`2^60` 与 `2^60+1` 是不同 inode，却有相同 Number 值；因此产生与 CI 相同的 distinct-files 错误。原 Windows 日志没有记录原始文件 ID，现场精度碰撞仍是由日志和回归支持的根因推断，不冒称已采集该主机 stat。新实现使用 BigInt dev/ino、size/mode 与纳秒时间；真实 hardlink 仍在任何 rename 前拒绝。同批 control/runtime 固定 fd 读取和 C/D/worker 锁清理也保留精确身份，只在文件已限于16 MiB后将 size 转为 Number 分配 buffer，不把 BigInt 写入 JSON 状态。Windows 重试边界、实际 ACL 和生产权限 deadline 保持。

两个新合同先红后绿，完整本机 Node24/26 各 **644 项、643 通过、1 项 Windows 专用跳过、0 失败**；新增合同累计76项。独立审查 READY。最新源码需重新执行实际 Windows CI，ST-04 仍进行中；详见 [metrics.json](metrics.json)。历史成功、失败和中间快照保持原样。

另在固定 b692 源码的隔离安装包中，使用实际默认 detached launcher，先后通过38项和补充输入先落盘的40项断言：带空格 prefix、任意 cwd、外置 state/cache、显式 start 复用、pause 零 POST、resume 同 PID/token 单次输入、stop 保留绑定/游标/回执。两轮共4个所属 worker 都正常停止后确认退出。该验证只用 macOS loopback fake 服务，没有模型、真实 harness、SSH 或用户 state；它不替代新源码 Windows 验收。

包身份分别记录：较早本机 smoke 的268746字节先于 b692 最后文档；固定 b692 checkout 的 CI 包为270894字节，私有 archive fixture包为270867字节。两者76文件内容逐一等于 b692，但 tar mode 元数据不同，不能混称同一字节发行资产。上述均为验收产物，固定 RC 资产仍由 ST-09 完成。

后续平台结果已完成：同运行源码的五组CI全部通过；实际Windows334项/329pass/5skip/0fail/0cancel，完整结果另存[最终验收](../lifecycle-20261020-v6/README.md)。本页及metrics保留先前“平台待验”时的阶段事实。
