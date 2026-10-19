# 后续工作

当前状态入口为[STATUS.md](STATUS.md)。下方早期顺序和日期段保留当时记录，后续当前工作以末尾稳定化增量及[稳定化计划](V0.3-STABILIZATION-PLAN.md)为准。

公开稳定版 v0.2.0 提供用户级安装、独立通信空间、固定依赖安装和本机已有 OpenCode 聊天接入。多机部署时，每机独立配置本地服务；该稳定版的 room 尚未跨节点传输。

2026-10-17 v0.3开发进度补充：统一adapter、Codex共享daemon客户端、签名节点/room与SSH收发已实现；两个独立本机节点的真实免费模型项目协作通过。上表按原顺序保留，真实双机SSH验收、Kimi/Pi已有会话adapter和退出恢复继续推进。具体合同见[V0.3-DESIGN.md](V0.3-DESIGN.md)，操作见[NODES.md](NODES.md)。

| 顺序 | 工作 | 验收 |
|---|---|---|
| 1 | 真实项目试用 | 两三个明确选中的已有聊天协作完成一项小任务，保留上下文与可核对回复 |
| 2 | 统一adapter，加入Codex | 同一严格room中双方主动问答，错会话/忙碌/不确定提交分别处理 |
| 3 | 安装与运维完善 | 扩展平台验证，增加明确pause/resume、升级迁移与安全残留锁恢复 |
| 4 | 跨节点room | 节点配对、全局消息引用、双侧权限与会话校验，重连不误投 |
| 5 | 退出进程恢复 | 按明确能力和白名单启动/恢复，权限请求保持可见 |

每台机器保留自己的数据库和原生服务；通过传输交换消息，不共享打开SQLite或克隆同一个活动节点身份。原生服务保持loopback，初期远端仅允许消息与回执。

Codex已有实例接入、启动进程恢复旧thread、当前桌面聊天接入分别验收。不会把恢复进程视为已连接当前桌面实例。

2026-10-18 状态补充：v0.3 开发版已补齐[真实双机 SSH 协作验收](../verification/vps-integration-20261018-v5/metrics.json)，40/40 项通过；[独立 SSH 观察与受控客户端故障恢复](../verification/vps-observer-20261018-v1/metrics.json) 11/11 项通过。上表顺序与验收目标保持不变，本轮提供其中 Codex adapter、跨节点 room 及精确会话通信的实机证据。测试使用 macOS arm64 的 Codex CLI 0.162.1 独立验证 server / 原测试 thread 和 Debian 13 x64 VPS OpenCode 2.0.20。当前活跃 Desktop 聊天接入、Kimi/Pi 已有会话、生产生命周期及退出进程恢复仍待扩展；观察客户端 gate 不等于公网/VPS 断网或完整离线运维验收。持久 lease 仅用于验收 helper，未加入生产 adapter 自动 resume 或进程重启。稳定 Release 保持 v0.2.0。


## 2026-10-19 稳定化与正式交付规划

当前新增阶段见[V0.3-STABILIZATION-PLAN.md](V0.3-STABILIZATION-PLAN.md)。早期条目与当时状态保留为历史；最新已验证范围以[兼容性说明](COMPATIBILITY.md)和独立验收报告为准。核心跨机、多个原生adapter、ZCode工具收件和查看器已具备实测证据，后续优先完成统一预检、无损暂停、分层对账、升级、实际项目试用和发行，暂缓新增生态范围。

本轮仅规划。新阶段ST-01起均待开始，不能把该计划里的建议CLI入口或验收矩阵当成当前实现/通过结果。


## 2026-10-19 ST-01 当前入口收敛

新增[当前状态与使用入口](STATUS.md)，按稳定/开发版本、平台、原生投递/工具收件/CLI 路径区分证据。早期段落里的“尚待真实双机”“Kimi 待扩展”等为历史状态；现有 Mac↔VPS、Windows↔Mac、Kimi Windows/Linux↔Mac 和 ZCode Mac 同机实测分别引用原报告，不重写历史计数。ZCode 跨物理机、Windows ZCode 桌面和 Pi 严格已有聊天 adapter 仍未据此完成。

当前执行 ST-01 文档入口与 ST-02 设计。`node flush --message m_UUID` 是已有原 ID 重试能力；统一预检、保留绑定 pause/resume、分层对账操作、升级回退和 RC 仍属后续工作。`detach` 继续表示停用绑定。本文增量没有启动模型、远端部署或发布新版本。

## 2026-10-19 ST-03 实现增量

ST-01/02已完成，最新开发分支新增[统一预检](INSPECT.md)：默认本地元数据只读，显式准确binding才查询native，Kimi冷会话额外选择，稳定原因码区分未探测与待核对。新增32项合同及本机全量/隔离安装包通过；平台结果另见本次CI。保留binding的pause/resume、安全恢复、升级及真实跨机连续试用仍未实施。历史段落保留其当时状态。
