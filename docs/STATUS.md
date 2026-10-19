# 当前状态与使用入口

更新日期：2026-10-19。本页汇总当前已实现能力和操作入口；逐版本合同及历史记录见[兼容性说明](COMPATIBILITY.md)，后续工作见[稳定化计划](V0.3-STABILIZATION-PLAN.md)。文档更新本身不代表完成计划中的新功能或重新执行历史验收。

## 1. 先选择要安装的版本

| 版本入口 | 包含什么 | 怎么选择 |
|---|---|---|
| 稳定 Release `v0.2.0` | 用户级安装、独立通信空间、hcom 依赖安装、本机 OpenCode 已有聊天协作 | 需要该历史稳定范围时安装固定 Release；不包含下方 v0.3 多机、Windows、Kimi、ZCode、查看器等新增能力 |
| 开发分支 `codex/multinode-adapters` | 本页 v0.3 已实现能力；源码 package version 为 `0.3.0`，尚未发行新的稳定 Release | 首轮试用最新功能使用该分支；两端固定同一完整提交，不把分支名当作不可变版本 |
| 已有通信验证基线 `00295d77ab8660565e0772985a4387f9351ffb37` | 包含多机、多 harness、ZCode 工具收件和查看器；其后 `d861b5b` 为规划，最新开发分支又新增统一预检 | 复用本页历史通信实测范围可固定此提交；**此基线没有新的 inspect**，尚无稳定化 RC/升级验收 |

稳定包：

```bash
npm install -g https://github.com/IDLE-Cloud/agent-dialogue/releases/download/v0.2.0/idle-cloud-agent-dialogue-0.2.0.tgz
```

固定已有验证开发基线的安装入口：

```bash
npm install -g 'git+https://github.com/IDLE-Cloud/agent-dialogue.git#00295d77ab8660565e0772985a4387f9351ffb37'
```

需要跟踪后续开发时，可将上述 fragment 换为 `codex/multinode-adapters`；安装前记录实际提交，所有参与节点核对同一版本。不要在活动 worker 使用的源码 checkout 上直接切版本。安装命令不运行模型；`setup`、接入和迁移另按对应指南执行。无 Git 的 Windows 私有 runtime/源码部署见 [WINDOWS.md](WINDOWS.md)，不要据此安装尚未发布的 v0.3 Release URL。

Node.js 要求为 22.13 或更新的受支持版本；Windows 实机和 CI 使用独立 Node 24。公开源码与 Release 下载无需 GitHub 登录，模型账号及工具批准继续由原 harness 管理。

## 2. 已实现能力按证据分级

“已实测”只覆盖表内指定平台、版本和接入路径；“合同/CI”不能替代该桌面或硬件的模型实测。

| 路径 | 现在可做什么 | 已有真实证据 | 仍需遵守的边界 |
|---|---|---|---|
| OpenCode V2 `2.0.20` | 选完整已有 session，绑定、自动原生投递、保留上下文并主动回复 | macOS arm64 本机；Debian 13 x64 VPS 跨机；对 Windows V1/Kimi 和本机 ZCode 的通信 | 每机只连接本机所选 loopback 服务；原模型、审批和目录保持；其他版本需另核验 |
| OpenCode V1 `1.19.0` | `sessions opencode-v1` / `attach opencode-v1`，空闲后提交并核验持久输入 | Windows 11 x64 ↔ Mac，真实 FRP/SSH 双向通信 | 独立 V1 服务描述；不与 V2 混用；不接管另一活动 TUI；Windows worker 依赖当前用户已登录 |
| Codex app-server | 精确 thread UUID、原生队列、显式 `--resume` 同一原 thread | macOS arm64 CLI `0.162.1` 专用验证 server ↔ Debian VPS OpenCode | 共享 daemon `0.163.0` 协议另有合同；不等于接入当前活跃 Codex Desktop；未证明 Windows Codex 实机接入 |
| Kimi Code `2.1.1` / `2.2.0` | 精确选择原生 Web 服务拥有的 session，空闲投递、持久输入核验及主动回复 | Windows `2.1.1` / Linux `2.2.0` 分别 ↔ Mac OpenCode | 固定服务身份、workspace 和会话允许清单；不抢占另一活动 TUI；读取冷会话可能加载它 |
| ZCode Desktop `3.14.3` | 宿主 MCP metadata 核对原聊天，私有 scope 固定身份/room/peer；工具主动收发 | Mac ZCode ↔ OpenCode，同机两个独立节点，两轮真实问答 | **tool-pull，空闲聊天不自动唤醒**；`tool-read` 不等于原生输入受理；Windows 应用、插件市场安装及跨物理机 ZCode 待实测 |
| hcom CLI `launch` | 启动 Codex/OpenCode/Kimi/Pi 受管 CLI；与精确 room adapter 分别使用 | Codex/OpenCode 本机原型有模型记录；Pi 启动/消息交入有观察但模型回复受额度影响 | 不等于已有聊天接入；embedded 后端不提供 `launch`/hcom hooks；Kimi launch 不能套用 Kimi 原生 adapter 的验收 |

跨机签名节点、共同 room、双向 SSH、全局回复引用和本地排队均已实现。每机保留独立 node 身份及账本，原生服务凭据不离开本机；无自动中继、跨机共享打开的 SQLite 或多用户权限隔离。通信角色由项目决定。

只读查看器已支持本机和固定 SSH 来源、签名副本合并、准确聊天、回复定位、实时更新及 JSON/Markdown 导出。它显示发到 room 的实际通信，并非所有原生聊天、内部思考或子 agent 历史；查看不触发模型、不重试消息。

平台补充：macOS x64、Linux GNU arm64 和 WSL 的安装/分发范围见[兼容性说明](COMPATIBILITY.md)，不能由上述 arm64 Mac/x64 Linux 结果外推。Linux 不含 Alpine/musl。Windows 原生 embedded 不是 WSL，也不兼容已有 hcom 数据目录。

## 3. 当前可执行操作与待实现内容

| 情况 | 当前可用操作 | 不能据此认为已完成 |
|---|---|---|
| 统一预检 | 最新开发分支的 `inspect --json`；显式选择本地聊天后用 `inspect --binding ALIAS --native --json`，见[预检说明](INSPECT.md) | 默认仅本地元数据和 ledger 文件头；不证明进程在线、完整历史健康或跨机连通；Kimi 冷会话查询需额外 flag |
| 原有环境诊断 | `doctor --json`，另用 `bindings` / `bridge status` / `node status` 核对对应信息 | `doctor` 会执行第三方版本命令；通过不代表聊天已接入，旧查询路径也不统一承诺源文件字节不变 |
| 工作中的原生 adapter | 服务和准确聊天可受理时，worker 按其能力投递；busy/审批/队列由原 harness 处理 | 模型任务完成、审批获准或所有桌面自动唤醒 |
| ZCode 收件 | 在准确原聊天明确要求调用 `dialogue_inbox`；工具读取后按项目需要回复 | 自动 idle wake、原生 prompt 注入或 `native-admitted` |
| 跨节点 `m_UUID` 待确认 | 核对原 ID 与证据后用已有 `node flush --message m_UUID`，重用原签名内容 | 新建另一条消息替代重试；自动清除未知状态 |
| 本地 `q_UUID` / `outgoingPending` 或原生 pending | 保留原 ID、账本、输入及 worker 状态，分层人工核对 | 通用自动修复/清 pending 命令；按正文猜测关联；ZCode 工具读取套用 native admission |
| 活跃绑定的 worker 未启动 | 核对准确服务、session 和 pending/锁后，按现有合同 `bridge start ALIAS` | 保留绑定的 pause/resume 已实现；它仍是 ST-04 待做项 |
| 结束绑定 | `detach ALIAS` 停用绑定并停止其所属 worker，原聊天/历史保留 | 无损暂停；已 detach alias 不能用 `bridge start` 复活，再接入须新 alias/room |
| 升级、进程退出、残留锁 | 按[迁移说明](MIGRATION.md)离线保留完整状态，核对确切写入者及所有权 | 自动拉起原生进程、开机/注销恢复、自动破锁，或已经验收的通用升级/回退流程 |

统一预检已进入最新开发分支。保留绑定暂停、分层恢复、升级回退、一次连续真实项目试用和 RC 包仍是[稳定化计划](V0.3-STABILIZATION-PLAN.md)的后续工作；预检不提供自动修复。当前新阶段不能据已有通信测试标为整体完成。

## 4. 按目的选择操作入口

| 你要做什么 | 入口 |
|---|---|
| 第一次从已有聊天开始，两机逐步配置 | [中文操作手册](QUICKSTART-ZH.md)，Mac V2 ↔ Windows V1 完整例子 |
| 核对程序/state/cache/backend 与服务路径 | [配置说明](CONFIGURATION.md) |
| 安装前后只读排错、显式核对准确聊天 | [统一预检](INSPECT.md) |
| 交换节点卡片、room 与原 ID 重试 | [节点通信](NODES.md) |
| Windows 私有 Node、ACL、PowerShell 路由 | [Windows 指南](WINDOWS.md) |
| Kimi Web 服务、会话允许清单与 global_user 布局 | [Kimi 指南](KIMI.md) |
| ZCode 应用原聊天与 MCP scope | [ZCode 指南](ZCODE.md) |
| 给原生 adapter 聊天分配自己的说明 | `agent-guide --room ID --from SELF [--to PEER]`；[操作者补充指南](USAGE.md)、[Agent 协议](AGENT-GUIDE.md) |
| 给 ZCode 聊天分配自己的说明 | [ZCode 指南](ZCODE.md)中的 `mcp-context`；不要把其他聊天的 self scope 发给它 |
| 看多机通信及读取/受理证据 | [查看器指南](VIEWER.md) |
| 替换旧程序、移动 state、核对版本 | [迁移说明](MIGRATION.md) |
| 首版还要完成什么 | [稳定化计划](V0.3-STABILIZATION-PLAN.md)、[历史路线图](ROADMAP.md) |

每个 agent 使用自己准确聊天绑定的 alias 与 scope/指南；同一个角色名、窗口标题或“最新聊天”不足以选择会话。room 决定通信对象，不复制或隔离原聊天上下文。

## 5. 历史证据入口

这些是已有记录，不是本次文档收敛重新跑出的结果：

| 验证 | 已保存结果 | 限制 |
|---|---|---|
| [Codex ↔ VPS OpenCode](https://github.com/IDLE-Cloud/agent-dialogue/blob/00295d77ab8660565e0772985a4387f9351ffb37/verification/vps-integration-20261018-v5/metrics.json) | 40/40 | 两物理机、指定 CLI server/thread；不等于活跃 Desktop |
| [Windows OpenCode ↔ Mac](https://github.com/IDLE-Cloud/agent-dialogue/blob/00295d77ab8660565e0772985a4387f9351ffb37/verification/windows-integration-20261019-v2/README.md) | 21/21 | FRP/SSH 双向，指定 `1.19.0` V1；任务初次清理问题及修正另有记录 |
| [Kimi Windows/Linux ↔ Mac](https://github.com/IDLE-Cloud/agent-dialogue/blob/00295d77ab8660565e0772985a4387f9351ffb37/verification/kimi-integration-20261019-v2/README.md) | 56/56、53/53 | 各自 4 条签名消息；限定命令和合成事实的受控验收 |
| [ZCode Desktop ↔ OpenCode](https://github.com/IDLE-Cloud/agent-dialogue/blob/00295d77ab8660565e0772985a4387f9351ffb37/verification/zcode-desktop-20261019-v1/README.md) | 通信 16/16、viewer 15/15 | 同一物理 Mac，工具收件；一次测试控制器纠正保留 |
| [验证基线 CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39251920656) | 五组通过；本机历史 536 项中 535 通过、1 项平台跳过；Windows 216 项中 214 通过、2 项平台跳过 | 自动测试/包检查不调用模型；平台跳过不是失败，也不能写成该平台模型实测 |

后续结果独立追加，历史报告、失败记录和原计数保持原样。
