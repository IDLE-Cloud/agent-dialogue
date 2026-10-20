# agent-dialogue

[![Tests and installation](https://github.com/IDLE-Cloud/agent-dialogue/actions/workflows/test.yml/badge.svg)](https://github.com/IDLE-Cloud/agent-dialogue/actions/workflows/test.yml)

让不同电脑、不同 harness 中的 agent 使用各自的项目聊天交流。既可以启动受管 CLI，也可以把已有 OpenCode / Codex / Kimi 原生聊天或 ZCode 桌面工具会话加入项目讨论，保留原会话与上下文；不要求新建“通信专用会话”或预先定义业务角色。

v0.3 开发版增加节点签名、双向配对、共同 room 和 SSH stdio 传输，每台机器只调用自己的本地 harness。2026-10-18 已完成 [Codex ↔ VPS OpenCode 真实双机验收](verification/vps-integration-20261018-v5/metrics.json)，40/40 项断言通过，包含双向模型问答、接入前上下文、全局回复关联、实际 JSON 产物和 SSH 重放/拒收检查。Codex 范围是 macOS arm64 上独立的 CLI 验证 server 与明确选择的原测试 thread；具体平台及已有聊天边界见 [兼容性说明](docs/COMPATIBILITY.md)。公开稳定 Release 仍为 v0.2.0。

**当前入口见[状态与支持总览](docs/STATUS.md)**，先区分稳定 `v0.2.0` 与 v0.3 开发快照。第一次多机使用按[中文操作手册](docs/QUICKSTART-ZH.md)完成安装、已有聊天接入、room 和对话查看；[操作者补充指南](docs/USAGE.md)解释逐 agent 分配说明。让其他 agent 知道怎么用时，先给项目加入[通用规则片段](config/AGENTS.snippet.md)，再用 `agent-dialogue agent-guide --room ID --from SELF [--to PEER]` 为每个聊天生成自己的准确上下文；不要让多个 agent 共用同一个 `--from` 身份。

最新开发分支提供[统一预检](docs/INSPECT.md)：`agent-dialogue inspect --json` 默认只读本地已有元数据，未 setup 也可运行；明确 `--binding ALIAS --native` 才查询对应原生聊天。本轮又新增[保留绑定的暂停、恢复与 worker 停止](docs/LIFECYCLE.md)，首次须静止整个通信空间并显式 `state upgrade --offline` 升级 v1→v2。历史固定基线和 v0.2.0 不含这些命令；预检不自动修复或唤醒模型，pause 也不取消已受理的模型执行。

后续ST-05第一批已实现[显式v3、固定q来源、MCP同key恢复和停止worker后的receipt对账](docs/RECOVERY.md)，并通过[七组平台验收](https://github.com/IDLE-Cloud/agent-dialogue/blob/codex/multinode-adapters/verification/recovery-20261020-v2/README.md)。ST-05仍进行中；原生pending修复、残留锁处理、通用升级回退和新稳定Release继续待完成。

## 安装

需要 Node.js 22.13 或更新的受支持版本，以及准备使用的 harness；从 Git 安装还需要 Git。模型账号和权限继续由各 harness 自己管理。本包没有 npm 运行依赖，也没有自动下载或联网的 `postinstall`；hcom 通过显式 `setup` 安装。

公开仓库和 Release 均可直接下载，无需 GitHub 登录。安装固定版本 v0.2.0：

```bash
npm install -g https://github.com/IDLE-Cloud/agent-dialogue/releases/download/v0.2.0/idle-cloud-agent-dialogue-0.2.0.tgz
agent-dialogue setup
agent-dialogue doctor
```

如果服务器的全局npm目录不可写，可以使用用户级prefix，不需要sudo：

```bash
npm install -g --prefix "$HOME/.local" https://github.com/IDLE-Cloud/agent-dialogue/releases/download/v0.2.0/idle-cloud-agent-dialogue-0.2.0.tgz
export PATH="$HOME/.local/bin:$PATH"
```

也可以从仓库安装当前稳定 main：

```bash
npm install -g git+https://github.com/IDLE-Cloud/agent-dialogue.git
agent-dialogue setup
agent-dialogue doctor
```

本页的节点、Codex 原生队列、Windows、Kimi、ZCode 和查看器功能位于 v0.3 开发分支，稳定 `v0.2.0` 不包含这些能力。测试最新开发状态可明确安装：

```bash
npm install -g 'git+https://github.com/IDLE-Cloud/agent-dialogue.git#codex/multinode-adapters'
agent-dialogue setup
agent-dialogue node status
```

分支会变化。需要复用当前已验证运行基线时，安装 `git+https://github.com/IDLE-Cloud/agent-dialogue.git#00295d77ab8660565e0772985a4387f9351ffb37`；该提交仍是开发快照，两端使用同一完整提交，尚非新的稳定 Release。现有 worker 未停止前，不替换它正在使用的安装目录。

或从源码安装开发分支。`npm link` 使用该源码目录，因此之后应保留它：

```bash
git clone --branch codex/multinode-adapters https://github.com/IDLE-Cloud/agent-dialogue.git
cd agent-dialogue
# 如需固定上述历史基线，再 checkout --detach 对应完整提交。
npm link
agent-dialogue setup
agent-dialogue doctor
```

安装程序与通信空间分开。默认状态为 `~/.local/state/agent-dialogue/spaces/default`，依赖缓存为 `~/.cache/agent-dialogue`，支持 XDG 和显式环境变量覆盖。不会因为切换项目目录就自动加入另一个通信空间，详见 [配置说明](docs/CONFIGURATION.md)。

## 已有项目聊天协作

对于已安装并配置好的OpenCode 2.0.20，可用 `opencode service start` 启动本机服务、`opencode service status` 查看状态。工具只连接现有 loopback 服务，不自动启动服务，也不改变用户配置。列出聊天后，用完整 session ID 选择具体会话：

```bash
export AGENT_DIALOGUE_SPACE=my-project

agent-dialogue sessions opencode --cwd /absolute/path/to/project

# 将示例 ID 换成清单中的完整原生 ID；两个聊天可以位于不同工作目录。
agent-dialogue attach opencode --session ses_实际ID甲 --alias code-a
agent-dialogue attach opencode --session ses_实际ID乙 --alias code-b
agent-dialogue bindings

agent-dialogue room create --name design-review --members code-a,code-b
```

记录返回的完整 room ID。操作员可以向其中一个聊天提出协作要求：

```bash
agent-dialogue collab send \
  --room r_实际房间ID --from operator --to code-a \
  --message '结合已有项目上下文，向 code-b 询问方案的边界，并汇总意见。'

agent-dialogue history --last 50 --thread r_实际房间ID
agent-dialogue bridge status
```

收到消息的原生 adapter 聊天会得到同一 CLI 的收发说明。它通过 shell 工具使用指南中的完整 `collab send --queue --from 自己的别名 --to 对方别名` 主动发问或回复，后台 worker 再投递。回复保留收到的完整命令：本机消息为数字 event ID，跨节点为全局 `m_UUID`；`--expected-session 完整ID` 断言接收会话。沿用原聊天的模型、上下文和工具批准策略。ZCode 使用 [MCP 工具与私有 scope](docs/ZCODE.md)，由原聊天主动收件。

room 固定成员的原生服务、session、项目目录和绑定代次；实际投递到精确 session API，不按标题或“最新聊天”猜测。界面切到其他聊天不会改变绑定。一个已有聊天可参加多个 room，这些 room 共享该聊天的模型上下文。

结束接入时：

```bash
agent-dialogue detach code-a
agent-dialogue detach code-b
```

`detach` 停止桥接，保留原生聊天和历史。历史 alias 不复用；接入新聊天时明确新建 alias 和 room。

## 多电脑与多 harness

在每台机器安装同一版本，接入该机器上的已有聊天，再交换签名节点卡片与 room 清单。传输只允许进入对端固定的 `node receive`；OpenCode API、Codex socket 和模型凭据继续留在各自本机。已有 ZeroTier 可承载 SSH，工具不另外部署 MQTT 或开放消息端口。

```bash
# 在各自机器上，选择本机已有的精确聊天。
agent-dialogue node init --name computer-a
agent-dialogue sessions codex --cwd /absolute/path/to/project
agent-dialogue attach codex --session FULL_THREAD_UUID --alias codex-a

# 如果上一步因线程未加载而拒绝，改用这一行；两行attach选其一。
# 显式选择后才加载同一个原线程。
agent-dialogue attach codex --session FULL_THREAD_UUID --alias codex-a --resume

agent-dialogue node export > card-a.json
```

对方可以使用 OpenCode，也可以使用 Codex。节点卡片需要双向导入，共同 room 由一端创建、签名导出，另一端明确接受后才允许投递。完整的两机步骤和对端路径配置见 [NODES.md](docs/NODES.md)。跨节点回复使用全局 `--reply-to m_UUID`，本地数字事件 ID 只在各自账本内有效。

Codex adapter 使用已有共享 daemon 的原生队列，默认要求线程已经加载并可接受输入。`--resume` 加载原线程，不等同于连接任意活跃桌面窗口。worker 只尝试启动本桥接已受理的队列输入；忙碌或其他来源的队列首项会等待，不改变原聊天的模型或权限。

Codex的受限shell可使用`collab send --queue`先写本地hcom账本，由后台worker完成原生API和SSH投递；原生投递说明默认提供此形式。通信state仍需位于该线程允许写入的目录。已用保持`workspaceWrite`、禁用网络及原模型的Codex测试线程完成主动发问、OpenCode关联回复和项目事实返回，7项真实断言通过；这轮明确使用专用本机验证server，不能当作任意活跃桌面窗口附着的证明。

## 让参与 agent 学会使用

`agent-dialogue agent-guide` 输出通用通信协议；接入并建立 room 后，按当前聊天的 alias 生成精确上下文：

```bash
agent-dialogue agent-guide --room r_ACTUAL_ROOM --from codex-a --to opencode-b
agent-dialogue agent-guide --room r_ACTUAL_ROOM --from opencode-b --to codex-a
```

生成结果包含准确身份、绝对命令、state 环境前缀、queue 和 expected-session 示例，只读本地元数据，不会发消息。分别交给对应聊天，并明确要求它读取。通用规则可以追加到项目已有的 `AGENTS.md` 或 harness 本来使用的规则文件，保留原规则；已有会话不保证自动重新加载。每个聊天使用自己的 `--from` 上下文，具体步骤及各 harness 规则入口见[使用指南](docs/USAGE.md#4-把用法交给每个-agent)，完整静态协议见[AGENT-GUIDE.md](docs/AGENT-GUIDE.md)。规则发现解决“知道如何调用”；其他 harness 的已有会话投递仍需要对应 adapter。

## 启动 Codex、OpenCode 等 CLI

这条路径复用 hcom 的原生集成，和上面的已有聊天 room 路径分别使用：

```bash
agent-dialogue launch codex --cwd /absolute/path/to/project --interactive
agent-dialogue launch opencode --cwd /absolute/path/to/project --interactive
agent-dialogue list

agent-dialogue send codex-实际名称 \
  --message '请通过 hcom 向 opencode-实际名称询问这个项目的方案，并汇总回答。' \
  --intent request --thread project-discussion
```

`launch` 创建受管 CLI 进程，不是接入当前 Codex 桌面聊天。`send` 是原有 hcom 端点路径；它尚未使用原生 OpenCode room 的严格会话合同。Kimi/Pi 有启动入口，具体模型可用性与验收范围见 [兼容性说明](docs/COMPATIBILITY.md)。

## 消息与故障边界

消息正文保存在所选本地账本（hcom 或 embedded），绑定和回执保存在当前通信空间。`collab send` 成功表示入账，worker 的 `admitted` 表示原生会话受理，实际模型回复另行核对。结果不确定时先查同一输入 ID；无法确认时保留待核对状态，不盲目重复提交。最新源码的 `bridge pause/resume` 保留准确绑定与进度，pending/未知结果会阻止安全恢复；`bridge stop` 只停所属 worker，enabled 时直接入口仍可工作。用法及与 detach 的区别见[生命周期指南](docs/LIFECYCLE.md)。ST-05第一批增加[显式v3、固定q来源与停止worker后的证据对账](docs/RECOVERY.md)，证据不足保持needs-review；通用native pending修复、残留锁恢复及升级回退仍待完成。

本机 alias 适用于同一用户的可信进程。跨节点签名固定发送节点，room 固定双方绑定；它们没有把每个模型变成独立的 OS 用户。网络中断或回执丢失时用 `node status` 和 `node flush --message m_UUID` 对账，同 ID 同内容返回原回执。`remote-stored` 只代表对方账本收妥，原生会话受理和实际模型回复分别核验。

更多配置见 [CONFIGURATION.md](docs/CONFIGURATION.md)，从原项目目录迁移见 [MIGRATION.md](docs/MIGRATION.md)，平台和功能边界见 [COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 在浏览器查看对话

v0.3 开发版提供本地只读观察台，无需 VPS：

```bash
agent-dialogue view
# 或明确聚合两个本机通信目录
agent-dialogue view --source 'Laptop=/absolute/path/to/state-a' --source 'Workstation=/absolute/path/to/state-b'
```

打开终端打印的本地访问链接，选择 room 即可查看消息、准确原生会话、回复引用和每份投递证据，支持实时更新、历史分页、筛选与 JSON/Markdown 导出。跨节点副本和已转发 queue 请求会按协议关联；“原生已受理”与“实际回复”分开显示。查看器读取稳定的 DB/WAL 副本，不调用会初始化状态的 hcom 查询命令，也不启动模型或重试通信。源目录不存在时只显示提示。

页面只展示已登记通信账本中的实际交换，原 harness 未发到 room 的总结和 Codex 内部 sub-agent 对话需要后续适配。v0.3 开发版新增显式 SSH 只读采集，可用 `view --config /absolute/path/to/viewer.json` 指定预期 node 和允许的 sealed room。[2026-10-18 独立观察验收](verification/vps-observer-20261018-v1/metrics.json) 11/11 项通过：两次放行真实 SSH、两次仅阻断观察客户端的测试 gate，验证旧数据保留、恢复及两端源文件字节不变；此 gate 不代表 VPS 或公网实际断网。使用、配置、只读边界及验收说明见 [VIEWER.md](docs/VIEWER.md)。

## 开发与下一步

```bash
node --test tests/*.test.mjs
```

开发分支已有 Kimi Code 2.1.1 / 2.2.0 原生会话 adapter、ZCode 3.14.3 桌面工具收件和多机通信实测。当前冻结首版范围，优先完成[稳定化计划](docs/V0.3-STABILIZATION-PLAN.md)中的预检、暂停/恢复、分层对账与交付；Pi、任意 Codex Desktop 接入和进程自动拉起后置。测试脚本 `scripts/node-integration.mjs` 可复现两个独立本机节点的真实免费模型协作，真实双机与受控观察恢复的独立 runner 见 [VPS 验收说明](docs/VPS-ACCEPTANCE.md)，`verification/` 保留脱敏指标。本仓库只分发实现、测试和使用说明，不携带原研究仓库的第三方源码快照、账号数据或完整聊天记录。

## Windows 原生节点开发版

Windows 接入使用独立 Node 24、embedded 通信账本、已有 FRP/OpenSSH 和明确的 PowerShell 路由，并提供 OpenCode `1.19.0` 的 `opencode-v1` 已有会话适配。使用前按 [Windows 部署说明](docs/WINDOWS.md)准备私有服务描述，再选择完整 session ID、配置双向节点和 room；普通 `opencode` 别名仍指向 V2。无需启动 WSL，也不覆盖现有全局 Node 或 harness。

Windows worker 使用当前用户交互登录下的无触发器计划任务，在 SSH 退出后继续运行；没有开机/注销恢复。原生 V1 收到消息与实际模型完成回复分别核验，能力边界及实机证据以该指南和独立验收记录为准。

2026-10-19：已完成[原生 Windows 双向实机通信](verification/windows-integration-20261019-v2/README.md)、[只读观察](verification/windows-observer-20261019-v1/metrics.json)与[普通权限任务自清理](verification/windows-lifecycle-20261019-v1/metrics.json)。该能力仍在开发分支；稳定 Release v0.2.0 不包含 Windows 接入。

从已有聊天开始使用，见[中文操作手册](docs/QUICKSTART-ZH.md)：按顺序完成双向配对、共同 room、逐 agent 引导、项目任务与查看记录，并说明停止后如何重新接入。

## Kimi Code 原生服务适配

开发分支新增 `sessions kimi` / `attach kimi`（`kimi-code` 同义入口），通过私有 `AGENT_DIALOGUE_KIMI_SERVICE_FILE` 选择 Kimi Code 2.1.1 / 2.2.0 原生 Web 服务。服务描述固定准确实例、workspace、目录和由该服务拥有的 session 清单；空闲时提交，核验完整持久 user 输入后才报告受理。它保持原模型与权限，不接管另一个活跃 TUI。Windows 的 Kimi Bash 使用 POSIX 命令，SSH 传输可单独使用 PowerShell。

已完成 Windows Kimi 2.1.1 与 Linux Kimi 2.2.0 各自对 Mac OpenCode 的双向真实通信：每端 4 条签名消息、2 对关联回复、双方各 2 次原生通信工具调用，Windows 56/56、Linux 53/53 门禁和来源检查通过。验收使用限定命令与合成事实。私有服务准备、服务器 `global_user` 安装布局、跨机 `--kimi-service-file` 路由、逐聊天指南与状态处理见 [Kimi 操作说明](docs/KIMI.md)。


ZCode 桌面工具收件开发入口见 [ZCODE.md](docs/ZCODE.md)：使用官方主机提供的 MCP `_meta` 核对准确聊天及工作区，scope 固定发送身份、room 和允许 peers；复用既有签名节点与账本，可主动收发及引用回复。它提供工具收件，不宣称外部消息会自动启动空闲桌面聊天；查看器单独显示工具可读取/工具已读取。已完成 [Mac ZCode 3.14.3 桌面 ↔ OpenCode 的两轮真实收发](verification/zcode-desktop-20261019-v1/README.md)：4 条签名消息、6 次实际原生 MCP 工具，原聊天中持久工具结果与全局回复引用均核对。该轮为同机两个独立节点；Windows ZCode 应用、自动空闲唤醒和插件商店安装尚未实测。


## v0.3 稳定化与正式交付规划

按[稳定化计划](docs/V0.3-STABILIZATION-PLAN.md)收口：统一预检与接入、保留绑定的暂停/恢复、分层对账、升级与回退、一次真实项目连续试用及固定发行包。该计划基于00295d7；ST-01 当前入口、ST-02 [操作设计](docs/STABILIZATION-DESIGN.md)和 ST-03 [统一预检](docs/INSPECT.md)已交付。ST-04 本轮源码已实现[生命周期命令与显式离线 v2 启用](docs/LIFECYCLE.md)，实际验收以本次运行及平台 CI 记录为准。分层恢复、通用升级回退、跨机 ZCode 项目试用和新稳定 Release 仍待后续实施/验收。当前已实现能力统一见[状态总览](docs/STATUS.md)。既有通信实测保持有效，支持版本和边界仍见[兼容性说明](docs/COMPATIBILITY.md)。
