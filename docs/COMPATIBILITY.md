# 兼容性与验证边界

Node.js 要求为 22 或更新版本，无 npm 运行依赖。`setup` 显式下载固定的 hcom 0.7.30 发布包并核对 SHA-256；安装全局命令本身不启动 agent、后台服务或模型调用。

公开的 v0.2.0 Release 资产为 `idle-cloud-agent-dialogue-0.2.0.tgz`，npm 包名为 `@idle-cloud/agent-dialogue`。可直接安装 [Release 包](https://github.com/IDLE-Cloud/agent-dialogue/releases/download/v0.2.0/idle-cloud-agent-dialogue-0.2.0.tgz)，无需 GitHub 登录。这个 JavaScript 包相同，`setup` 再按所在机器选择对应 hcom 二进制；Release 下载不代表已完成所有平台的模型验收。

## 平台

| 环境 | 分发范围 | 实际运行验证 |
|---|---|---|
| macOS arm64 | 固定发布包安装入口 | 原项目已完成本机 Codex/OpenCode 双向交流与 OpenCode 三个已有聊天协作；独立版70项测试、npm全局安装、固定依赖安装与幂等setup通过 |
| macOS x64 | 固定发布包安装入口 | 尚未完成该硬件上的真实模型验收 |
| Linux GNU x64 | 固定发布包安装入口 | Ubuntu CI已通过Node22/24/26测试、全局包安装、真实hcom setup和doctor；真实模型联调仍待该平台验收 |
| Linux GNU arm64 | 固定发布包安装入口 | 需要 CI 包校验与真实 harness 联调 |
| Windows 原生 | 当前不支持 `setup` | 尚未适配本机进程、路径与安装行为 |
| Windows WSL2 | 可选择 Linux 环境尝试部署 | 使用 WSL 内的 Node、harness 和服务；真实 WSL 端到端尚未验收，不等于连接 Windows 原生已有聊天 |

Linux GNU 发布包支持不包含 Alpine/musl。平台安装检查与真实模型验证分别记录，不能混为同一项通过。

## Harness 与路径

| 对象 | 可用入口 | 验证与限制 |
|---|---|---|
| Codex CLI | `launch codex`，hcom 原生收发 | macOS arm64 原型已验证与 OpenCode 双向问答及连续追问；严格已有聊天 room adapter 尚未完成 |
| OpenCode CLI | `launch opencode`，hcom 原生收发 | macOS arm64 原型已验证与 Codex 互通 |
| OpenCode 2.0.20 已有聊天 | `sessions opencode`、`attach`、`room`、`collab send` | 已验证精确原生 session、三个已有聊天项目问答、错误绑定拒收与 worker 重启检查；当前仅现有本机 loopback 服务 |
| Kimi Code CLI | `launch kimi` | 提供启动入口，尚未完成该版本真实双向模型验收 |
| Pi | `launch pi` | 原型已观察启动、绑定与消息交入；配置供应商额度错误使模型回复未通过 |
| Codex/ZCode 等桌面已有聊天 | 后续 adapter | 不能把新 CLI 或原 session 恢复启动描述为已经接入当前桌面聊天 |

OpenCode 原生 adapter 按本机 2.0.20 接口实现：`/api/session`、`/api/session/{ID}/prompt`、收件箱与消息查询。默认读取 `~/.local/state/opencode/service.json`，可用 `AGENT_DIALOGUE_OPENCODE_SERVICE_FILE` 明确选择另一本机服务记录。其他版本需要实际兼容检查，不自动套用旧版或网页最新 API。

模型账号、模型目录、免费额度与 shell 权限属于原 harness。已有聊天接入保留这些配置，不为获得回复自动切换供应商或放宽权限。工具通信成功不代表特定模型当前可用。

## 已知边界

- hcom的CLI启动会注入其hooks/plugin，并可能清理旧的hcom专有配置；通信state隔离不代表全部harness全局配置隔离。单纯安装及已有OpenCode原生attach不执行这类CLI启动配置。
- `launch/send` 与原生 `attach/collab send` 目前是两条路径；只有后者提供本版 room 的精确绑定检查，不能把任意 hcom 端点直接当作 room 成员。
- room 是讨论路由，不隔离已有聊天的模型上下文；两个 room 使用同一聊天就共享其历史。
- `admitted` 是原生接口受理回执；模型回复和项目产物需要另查证据。
- 当前没有自动拉起退出进程、任意远端控制、自动破锁或可承诺的完整离线 exactly-once。
- 不同机器各自安装后仍是独立节点。ZeroTier、MQTT 配对与跨机 room 尚未打通；不应通过把原生模型服务暴露到外网来代替。
- 当前面向同一用户的可信本机进程；alias、通信空间和 room 不是多用户认证或沙箱边界。

独立仓库的安装、单元和平台结果以其 CI/验证记录为准。原型通过项目问答不替代各平台上的兼容性验收。


首次独立发行CI：[run 39027853400](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39027853400)。Ubuntu Node22/24/26与macOS Node24四个job均通过70项测试、独立全局安装、真实依赖下载校验及doctor；它们不包含远程模型调用。
