# 兼容性与验证边界

Node.js 要求为 22.13 或更新的受支持版本，无 npm 运行依赖；Windows 部署示例使用独立 Node 24。Linux/macOS 的 `setup` 显式下载固定的 hcom 0.7.30 发布包并核对 SHA-256；Windows 开发分支使用内建 SQLite 账本，不下载 hcom。安装全局命令本身不启动 agent、后台服务或模型调用。

公开的 v0.2.0 Release 资产为 `idle-cloud-agent-dialogue-0.2.0.tgz`，npm 包名为 `@idle-cloud/agent-dialogue`。可直接安装 [Release 包](https://github.com/IDLE-Cloud/agent-dialogue/releases/download/v0.2.0/idle-cloud-agent-dialogue-0.2.0.tgz)，无需 GitHub 登录。这个 JavaScript 包相同，`setup` 再按所在机器选择对应 hcom 二进制；Release 下载不代表已完成所有平台的模型验收。

## 平台

| 环境 | 分发范围 | 实际运行验证 |
|---|---|---|
| macOS arm64 | 固定发布包安装入口 | 原项目已完成本机 Codex/OpenCode 双向交流与 OpenCode 三个已有聊天协作；独立版70项测试、npm全局安装、固定依赖安装与幂等setup通过 |
| macOS x64 | 固定发布包安装入口 | 尚未完成该硬件上的真实模型验收 |
| Linux GNU x64 | 固定发布包安装入口 | Ubuntu CI已通过Node22/24/26测试、全局包安装、真实hcom setup和doctor；Debian 13 x64 VPS 上 OpenCode 2.0.20 与 macOS Codex 的真实双机 SSH 模型验收已通过，见下方2026-10-18记录 |
| Linux GNU arm64 | 固定发布包安装入口 | 需要 CI 包校验与真实 harness 联调 |
| Windows 原生 | 开发分支支持独立 Node、`setup` embedded 账本、PowerShell SSH | OpenCode V1 1.19.0 adapter、私有 ACL 与当前用户 Scheduled Task worker 已实现并有合同回归；实际部署和模型验收分别记录，不能外推到任意既有 TUI 或桌面窗口。见 [WINDOWS.md](WINDOWS.md) |
| Windows WSL2 | 可选择 Linux 环境尝试部署 | 使用 WSL 内的 Node、harness 和服务；真实 WSL 端到端尚未验收，不等于连接 Windows 原生已有聊天 |

Linux GNU 发布包支持不包含 Alpine/musl。平台安装检查与真实模型验证分别记录，不能混为同一项通过。

## Harness 与路径

| 对象 | 可用入口 | 验证与限制 |
|---|---|---|
| Codex CLI | `launch codex`，hcom 原生收发 | macOS arm64 原型已验证与 OpenCode 双向问答及连续追问；与下方原生队列adapter分别验收 |
| Codex 0.163.0 共享 daemon | `sessions codex`、`attach codex`、`room`、`collab send` | 使用既有WebSocket-over-UDS；精确thread UUID/服务/CWD校验、稳定client输入ID、队列归属与显式resume已实现；真实模型验证另记 |
| Codex CLI 0.162.1 专用验证 server | `attach codex`、本地 submission、SSH room 通信 | macOS arm64 上显式选择并恢复同一个 owned 测试 thread，与 Debian VPS OpenCode 双向交流及项目 JSON 产物验收通过；不等于接入当前活跃 Desktop 聊天 |
| OpenCode CLI | `launch opencode`，hcom 原生收发 | macOS arm64 原型已验证与 Codex 互通 |
| OpenCode 2.0.20 已有聊天 | `sessions opencode`、`attach`、`room`、`collab send` | 已验证精确原生 session、三个已有聊天项目问答、错误绑定拒收与 worker 重启检查；Debian VPS 双机验收已通过。每个节点的 adapter 仍连接该节点本机 loopback 服务，节点之间使用 SSH |
| OpenCode 1.19.0 已有聊天 | `sessions opencode-v1`、`attach opencode-v1`、`room`、`collab send` | 使用操作者选定的本机服务描述，固定服务版本、项目、目录、shell 与完整 session；保持原会话 agent/model/variant。V1 无持久原生 inbox，只在空闲时提交，确认完整持久输入后才记 admitted；HTTP 204 本身不是受理证据。Windows 配置见 [WINDOWS.md](WINDOWS.md) |
| Kimi Code CLI | `launch kimi` | 提供启动入口，尚未完成该版本真实双向模型验收 |
| Kimi Code 2.1.1 / 2.2.0 原生服务聊天 | `sessions kimi`、`attach kimi`、`room`、`collab send`；`kimi-code` 为同义入口 | 开发分支新增固定 KAP REST adapter。只允许操作者选定的准确本机服务、workspace、目录及服务器拥有的 session 清单，空闲提交且核验完整持久 user 输入；不接管另一个活跃 TUI。17 项 adapter 单元测试通过；Windows 2.1.1 / Linux 2.2.0 各自对 Mac OpenCode 已完成受控双向真实模型通信，分别 56/56 与 53/53 门禁及来源检查。见 [KIMI.md](KIMI.md) |
| Pi | `launch pi` | 原型已观察启动、绑定与消息交入；配置供应商额度错误使模型回复未通过 |
| ZCode 3.14.3 桌面工具收件 | `zcode init`、MCP `dialogue_identity`、`sessions zcode`、`attach zcode`、`mcp-context` | 开发分支新增基于真实 MCP request context 的工具收件接入。`_meta` 的准确主聊天和工作区与操作者 scope 分别核对；可主动发信、读收件箱和关联回复。工具可读取/工具已读取不等于原生 user 输入受理，不自动唤醒空闲聊天。真实桌面验收单独记录，见 [ZCODE.md](ZCODE.md) |
| 任意桌面前端当前活跃聊天 | 后续集成 | 列表/绑定精确原生thread不代表已经连接该前端；不能把原thread恢复启动描述为已接入当前活跃桌面实例 |

OpenCode V2 adapter 按本机 2.0.20 接口实现：`/api/session`、`/api/session/{ID}/prompt`、收件箱与消息查询。默认读取 `~/.local/state/opencode/service.json`，可用 `AGENT_DIALOGUE_OPENCODE_SERVICE_FILE` 明确选择另一本机服务记录。V1 1.19.0 使用独立的 `AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE` 和 `/session/{ID}/prompt_async` 合同，不混用 V2 服务记录。其它版本需要实际兼容检查，不自动套用旧版或网页最新 API。

Kimi 原生 adapter 使用 `AGENT_DIALOGUE_KIMI_SERVICE_FILE` 选择私有服务描述，固定版本 2.1.1 / 2.2.0 和原生 `server_id`；SSH peer 路由可用 `--kimi-service-file` 指定接收端描述路径。它使用原生 `prompt_id` 关联持久消息 `id`，POST 接受或内存队列不构成 admission。Windows 的 Kimi Bash 工具使用 POSIX 语法，SSH 传输仍可独立选择 PowerShell。这里只列已实现协议，真实模型验收按独立记录判断。

模型账号、模型目录、免费额度与 shell 权限属于原 harness。已有聊天接入保留这些配置，不为获得回复自动切换供应商或放宽权限。工具通信成功不代表特定模型当前可用。

## 已知边界

- hcom的CLI启动会注入其hooks/plugin，并可能清理旧的hcom专有配置；通信state隔离不代表全部harness全局配置隔离。单纯安装及已有OpenCode原生attach不执行这类CLI启动配置。
- `launch/send` 与原生 `attach/collab send` 目前是两条路径；只有后者提供本版 room 的精确绑定检查，不能把任意 hcom 端点直接当作 room 成员。
- room 是讨论路由，不隔离已有聊天的模型上下文；两个 room 使用同一聊天就共享其历史。
- `admitted` 是原生接口受理回执；模型回复和项目产物需要另查证据。
- 当前没有自动拉起退出进程、任意远端控制、自动破锁或可承诺的完整离线 exactly-once。
- v0.3已有独立节点卡片、共同room、SSH stdio和全局消息ID；同机双节点与2026-10-18真实双机 SSH 场景分别保留验收结果。后者明确使用 macOS Codex 与 Debian VPS OpenCode，不能外推到未验收的 harness 或平台。详见[NODES.md](NODES.md)。
- 当前面向同一用户授权的可信节点与本机进程；alias、通信空间和 room 不是多用户认证或沙箱边界。
- Windows embedded 后端仅实现准确会话桥接需要的本地账本，不支持上游 hcom hooks、`launch`、原始 hcom 命令或 relay；不能混用已有 hcom 数据目录。Windows worker 的当前用户 Scheduled Task 无触发器、无提权且不存密码，可跨 SSH 退出存活，依赖用户处于登录状态，不代表开机或注销后自动恢复。
- OpenCode V1 busy 时保留待处理账本事件并显示 `waiting-native`，成功受理或明确拒绝后恢复 worker `ready`；`ready` 不表示模型完成。V1 服务实例没有原生进程 nonce，操作者在服务重启后仍需更新选定描述身份并重新核验绑定。
- Kimi 原生服务的冷会话索引不证明另一个进程的会话所有权；queue/messages 读取还可能加载冷会话。因此只接入明确由选定 Web 服务拥有的允许清单，首轮联调使用该服务新建的独立测试聊天。忙碌、审批/问题和已有队列时等待；不会自动批准、改模型、抢占活跃 TUI 或恢复退出进程。
- 真实验收使用的持久 Codex subscription lease 属于验收 helper。生产 adapter 不会因此自动 resume 聊天或重启退出的进程；这些动作仍需显式授权与对应实现。

## v0.3 开发验证

`verification/node-integration-20261017-v1/metrics.json`：两个普通OpenCode2.0.20聊天先保存项目事实，再接入两个独立state/node。免费deepseek-v4.1-flash-free实际shell发问和全局ID关联回复，综合双方原上下文；9项断言通过，18658ms，桥接均detach。使用同机local-process传输和一个原生OpenCode服务，没有真实两台机器或SSH端到端结论。

第二轮`verification/node-integration-20261017-v2/metrics.json`：17项断言通过，项目问答14562ms。同ID重放返回原远端event；同ID改正文重新签名、无效签名、未接受room通过实际CLI接收入口均被拒绝。原生稳定输入各仍为1，hcom消息和原生user输入数不变；2/2桥detach。

Codex共享daemon当前未加载的thread默认拒绝。明确`attach codex ... --resume`时才加载同一个原thread；不会新建thread、自动切换model或放宽工具权限。busy时只排队，worker仅尝试启动自己已确认受理的队列首项。原生queue/add成功与queue/start后的模型完成分别记录。

实现提交`be23e96`的[CI 39040659553](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39040659553)已完成：Ubuntu Node22/24/26与macOS Node24均通过130项测试、独立prefix全局安装、签名卡片导出、真实hcom下载校验与doctor。CI不调用模型，也不替代真实双机验收。

Codex原生测试首轮`verification/codex-integration-20261017-v1/metrics.json`为部分通过：显式恢复原测试thread，精确queue受理、启动与真实assistant回复通过；后续主动CLI协作未形成peer事件。追加诊断记录模型报告本地命令EPERM，原生turn未记录工具执行条目，因此只记录为模型报告。该原thread为`workspaceWrite`/`approvalPolicy=never`，首轮通信state确在其可写root之外；后续在原项目允许范围内设置state独立验证，不修改模型或权限。首轮partial保留。

2026-10-18补充：`verification/codex-integration-20261017-v2-retry/diagnosis.json`确认实际commandExecution失败，原turn配置禁用网络，失败输出来自CLI访问OpenCode API阶段。改用本地submission队列后，`verification/codex-queued-integration-20261018-v2/metrics.json`的7项真实断言通过：同一owned Codex原线程发起请求，原生shell工具返回queued，后台worker与正式消息映射吻合，OpenCode关联回复并返回其预存项目事实。模型和权限保持，Codex未获额外批准。旧共享daemon已不在运行，本次显式使用专用本机0.162.1验证server并恢复同一原thread，不宣称接入活跃桌面窗口。

双节点原场景于2026-10-18再验17/17通过，项目交流16536ms，证据为`verification/node-integration-20261018-v2/metrics.json`。同日v1因模型构造命令遗漏state前缀而被限定权限拒绝，其failed记录保留，没有放宽规则后冒充通过。新增排队、恢复状态和编码边界后的单元测试146项通过，打包/全局安装检查通过。

功能提交`07a5796`的[CI 39049968905](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39049968905)四组均成功，包含146项测试、安装检查与真实hcom setup/doctor；静态摘要见`verification/multinode-unit-20261018/metrics.json`。

独立仓库的安装、单元和平台结果以其 CI/验证记录为准。原型通过项目问答不替代各平台上的兼容性验收。


首次独立发行CI：[run 39027853400](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39027853400)。Ubuntu Node22/24/26与macOS Node24四个job均通过70项测试、独立全局安装、真实依赖下载校验及doctor；它们不包含远程模型调用。

## 2026-10-18 真实双机与观察恢复验收

冻结源码提交 `074603e6d38d60e438fb3fc18e9be40953980a2f` 的[真实双机验收](../verification/vps-integration-20261018-v5/metrics.json)通过 **40/40** 项断言：macOS arm64、Codex CLI 0.162.1 专用验证 server 中同一个 owned 原测试 thread，与 Debian 13 x64 VPS 上 OpenCode 2.0.20、`opencode/deepseek-v4.1-flash-free` 完成双向真实模型交流。双方独立节点通过真实 SSH stdio 交换四条全局消息，保留原生上下文，读取并验证实际生成的 nonce JSON 项目产物；重放、同 ID 改正文、坏签名、未接受 room 和错误目标 session 的负例均有证据。Codex 未获额外批准，OpenCode 仅为两条准确通信命令各获一次批准。两个 owned worker 已停止，原生聊天保留。这不是对当前活跃 Desktop 实例的接入验收。

[独立 SSH 观察恢复验收](../verification/vps-observer-20261018-v1/metrics.json)通过 **11/11** 项断言：初始及恢复后的两次采集实际经过 SSH，两个中间采集由专用 observer 客户端 transport gate 拒绝，随后恢复为新采集时间且五条逻辑消息不重复。它没有断开 VPS、网卡或公网，也没有修改 bridge route、SSH daemon 或全局 SSH 配置。观察阶段调用模型与原生 harness API 均为零；静止来源的本机11个、远端13个文件前后字节哈希一致。单元测试 **344/344** 和包含46个文件的安装包检查另行通过。上述结果属于 v0.3 开发分支，稳定 Release 仍为 v0.2.0。
