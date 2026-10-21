# Kimi Code：选择原生会话并接入多机协作

本指南对应 `codex/multinode-adapters` 开发分支，适配 **Kimi Code 2.1.1 / 2.2.0** 的本机 KAP REST 服务。稳定 Release v0.2.0 不包含该适配器。当前状态：**适配器单元测试通过，Windows Kimi 2.1.1 / Linux Kimi 2.2.0 各自与 Mac OpenCode 的受控双向真实模型通信已通过**。每端 4 条签名消息、2 对关联回复、双方各 2 次原生通信工具调用；Windows 56/56、Linux 53/53 门禁和来源检查通过。验收使用操作者限定命令与合成项目事实，不外推为自主协作质量。

`sessions kimi`、`attach kimi` 和 `kimi-code` 别名使用同一个原生 adapter；`launch kimi` 是上游 hcom 的另一条启动路径。Windows embedded 账本不提供 hcom launch/hooks。

## 1. 先确定服务和会话归属

接入对象是**你选定的原生 `kimi web` 服务所拥有的一段准确聊天**。Kimi TUI 可以在自己的进程中嵌入 harness；另一 Web 服务读取到同一历史 ID，不代表拥有那个 TUI 的执行状态。当前适配器不接管仍在其他 TUI/桌面进程中执行的聊天，不同时运行第二个 `kimi --session` 来驱动它。

首次联调使用独立 Web 服务及由它创建的测试聊天。确认效果后，可选择同一服务里已有的项目聊天，明确列入服务描述文件的 `sessionIds`。聊天标题只是辅助，必须核对服务身份、完整 ID、workspace 和原生目录。`sessionIds` 是操作者的明确选择；它不会自动发现或迁移其他进程的所有权。

## 2. 安装位置与原生服务

每台机器安装同一个 agent-dialogue 功能提交，使用 Node.js 22.13 或更新的受支持版本；原生 Windows 建议按 [WINDOWS.md](WINDOWS.md)准备独立 Node 24 和 embedded 账本。程序可以放工具目录，通信 state、Kimi 原生 home、项目目录分别选择，不必 clone 到每个项目。

服务器若使用 `global_user` 持久存储，可按下面的结构安排。`/ABS/GLOBAL_USER` 需要替换为你有权限使用的真实目录：

```text
/ABS/GLOBAL_USER/agent-dialogue/
  app/                 agent-dialogue 固定提交
  runtime/             可选的独立 Node / Kimi 运行时
  native/kimi-home/     Kimi config、认证、server.token 和原生会话
  workspaces/project/  参与协作的原生项目目录
  spaces/project-a/    当前机器的通信 state
  private/             服务描述和日志
```

共享 `global_user` 可以复用只读程序和运行时；每个同时运行的服务器实例必须选择自己的通信 state、Kimi home、服务描述和日志目录，例如 `spaces/rsi-1/project-a` 与 `spaces/rsi-2/project-a`。不要让两台机器同时使用同一个 `node.json` 或同一原生会话目录。更换实例后，先核对服务身份和路由，再决定迁移或新建节点。

使用已经安装的 **Kimi Code 2.1.1 或 2.2.0**，优先从该服务的 `/api/v1/meta` 或安装元数据核对版本；旧的 Python kimi-cli 是不同实现。固定版本联调时，在调用 CLI（包括版本查询）前设置下面的禁用自动更新变量。安装来源和账号配置遵循 [Kimi 官方仓库](https://github.com/MoonshotAI/kimi-code)。本工具不下载或替换全局 Kimi，也不自动迁移账号配置。选定的原生 home 需要已经配置可用模型及登录；多份进程共享 home 不等于可以同时驱动同一聊天。

**Linux/macOS：** 在专用终端选择原生 home，再启动服务。启动会持续占用该终端，服务横幅含访问凭据，只保存在你自己的终端或私有日志中。

```bash
umask 077
export KIMI_CODE_HOME='/ABS/GLOBAL_USER/agent-dialogue/native/kimi-home'
export KIMI_CODE_NO_AUTO_UPDATE=1
export KIMI_CLI_NO_AUTO_UPDATE=1
'/ABS/KIMI_BIN/kimi' web --no-open --port 58627
```

**Windows PowerShell：** 安装路径可用 C、D、E 等实际磁盘；原生项目也可以位于 `E:/Knowledgebase/Project`。以下路径均为示例。

```powershell
$env:KIMI_CODE_HOME = 'D:/Tools/agent-dialogue/native/kimi-home'
$env:KIMI_CODE_NO_AUTO_UPDATE = '1'
$env:KIMI_CLI_NO_AUTO_UPDATE = '1'
& 'C:/ABS/KIMI_BIN/kimi.exe' web --no-open --port 58627
```

默认只监听 `127.0.0.1`。如果端口已占用，Kimi 可能递增到下一个端口，以实际实例为准。保留 bearer 认证，不使用 `--dangerous-bypass-auth`。当前版本通过 `KIMI_CODE_HOME` 选择目录，不使用旧实现的 `--home` / `--config-file` 参数。

SSH 退出后的运行方式需要匹配所在平台：Linux 使用自己的进程管理器；Windows 在已登录用户的服务终端或明确安排的任务中运行。agent-dialogue 的 worker 与 Kimi 服务分别管理，启动 worker 不会自动启动退出的 Kimi。

## 3. 保存私有服务描述

Kimi 2.x 的 REST 入口为 `/api/v1`。使用选定服务的私有 `<KIMI_CODE_HOME>/server.token` 认证，先读取 `/api/v1/meta`、`/api/v1/sessions` 核对实例，再选取完整会话。首次测试可以通过该服务的原生 Web UI 创建独立聊天；创建聊天不要求先发送模型请求。

**首次发送前核对原生聊天的模型配置。** 当前版本的创建会话接口虽然接受 `agent_config`，创建路由并不应用它；本轮独立 home 中的 `default_model` 也没有让新聊天自动获得可运行的模型。先在该原生服务的 UI 中明确选择已经配置的模型，或由操作者使用官方 `POST /api/v1/sessions/FULL_SESSION_ID/profile`，请求正文为：

```json
{
  "agent_config": {
    "model": "EXISTING_CONFIGURED_MODEL_ALIAS"
  }
}
```

把占位符换成该 home 已有的模型 alias，再读取 `GET /api/v1/sessions/FULL_SESSION_ID/snapshot` 核对 live `agent_config.model`。这属于原生聊天的准备工作，不把模型选择加入桥接投递正文，也不为获得回复临时更换供应商或放宽权限。普通会话索引里的空模型投影不等于这项 live 检查。

2026-10-19 的 Windows 首轮准备输入已产生持久 user 消息，但原生引擎随后在调用模型前报告 `model.not_configured`；这不能记为认证失败或真实模型回复通过。操作者随后通过原生 profile 选择同一个既有配置的模型 alias，并以独立新 fixture 完成真实回复及双向通信验收；首轮失败记录保留。该例也说明，输入已持久受理与模型可运行是两件事。

将下面内容保存为仅当前用户可读的私有 JSON。Linux/macOS 可对新建文件设置 `chmod 600`；Windows 放在当前用户私有目录并核对 ACL。文件只保存 token 的绝对路径，不保存 token 正文。

```json
{
  "id": "REPLACE_WITH_META_SERVER_ID",
  "url": "http://127.0.0.1:58627",
  "version": "2.1.1",
  "tokenFile": "/ABS/PRIVATE_KIMI_HOME/server.token",
  "directory": "/ABS/NATIVE_PROJECT",
  "workspaceId": "wd_REPLACE_WITH_NATIVE_WORKSPACE_ID",
  "sessionIds": ["session_REPLACE_WITH_FULL_NATIVE_ID"],
  "commandShell": "posix"
}
```

Windows 将 `tokenFile` 和 `directory` 换为相应的 Windows 绝对路径，例如 `D:/Tools/agent-dialogue/native/kimi-home/server.token`、`E:/Knowledgebase/Project`。JSON 使用正斜杠可避免反斜杠转义错误。

| 字段 | 从哪里核对 |
|---|---|
| `id`、`version` | 该服务 `GET /api/v1/meta` 的 `server_id`、`server_version` |
| `url` | 该服务的准确回环 origin，不能携带账号、查询、路径或 token |
| `tokenFile` | 该服务 home 中已有的 `server.token`；不输出、不跨节点传输 |
| `directory` | 原生会话 `metadata.cwd`，必须是该机器上的绝对目录 |
| `workspaceId` | 原生会话 `workspace_id` |
| `sessionIds` | 仅允许该服务拥有、你明确选择的完整会话 ID；同一目录和 workspace |
| `commandShell` | 固定 `posix`，包括原生 Windows 的 Kimi Bash 工具 |

REST 通常用 HTTP 200 返回业务错误，须先检查 envelope 的 `code === 0`，再使用 `data`。普通 `GET /sessions/{id}` 的不忙状态不能证明其他进程已退出；读取 queue/messages 还可能加载冷会话。本适配器的 `sessions kimi` 只读取允许清单中准确聊天的索引元数据，避免遍历并加载其他聊天。

## 4. 选择通信空间并 attach

下面假设 `agent-dialogue` 已在 PATH。使用独立安装路径时，换成该机器的绝对 Node 和 `bin/agent-dialogue.mjs`，与 [中文操作手册](QUICKSTART-ZH.md)的 `ad` 函数用法相同。

**Linux/macOS：**

```bash
export AGENT_DIALOGUE_STATE_DIR='/ABS/COMMUNICATION_STATE/project-a'
export AGENT_DIALOGUE_CACHE_DIR='/ABS/COMMUNICATION_CACHE'
export AGENT_DIALOGUE_LEDGER=embedded
export AGENT_DIALOGUE_KIMI_SERVICE_FILE='/ABS/PRIVATE/kimi-service.json'

agent-dialogue setup
agent-dialogue doctor --json
agent-dialogue node init --name server-project-a
agent-dialogue sessions kimi --cwd '/ABS/NATIVE_PROJECT'
agent-dialogue attach kimi --session session_FULL_NATIVE_ID --alias kimi-server
agent-dialogue bindings
agent-dialogue bridge status
```

**Windows PowerShell：**

```powershell
$env:AGENT_DIALOGUE_STATE_DIR = 'D:/Tools/agent-dialogue/spaces/project-a'
$env:AGENT_DIALOGUE_CACHE_DIR = 'D:/Tools/agent-dialogue/cache'
$env:AGENT_DIALOGUE_LEDGER = 'embedded'
$env:AGENT_DIALOGUE_KIMI_SERVICE_FILE = 'D:/Tools/agent-dialogue/private/kimi-service.json'

agent-dialogue setup
agent-dialogue doctor --json
agent-dialogue node init --name windows-project-a
agent-dialogue sessions kimi --cwd 'E:/Knowledgebase/Project'
agent-dialogue attach kimi --session session_FULL_NATIVE_ID --alias kimi-windows
agent-dialogue bindings
agent-dialogue bridge status
```

`attach` 绑定同一原生聊天并启动桥接 worker，不新建替代聊天。第一次绑定一个 alias；已 detach 的 alias 不复用。若绑定已保存而 worker 启动失败，先核对 `bridge status`，修复后使用 `bridge start ALIAS`，不反复 attach。

适配器不会选择模型、修改权限或代替用户批准工具。描述文件的模型字段不是本适配器输入：原生模型和权限由 Kimi 管理。`agent-dialogue sessions` 中某些模型字段为空，是当前原生索引投影的范围，不表示可以自行填一个模型覆盖它。

## 5. 跨电脑路由

双方各自在本机 attach，互相导出/导入签名节点卡片；共同 room 的创建、签名导出与接受沿用 [NODES.md](NODES.md)。每条 peer 路由的服务文件、Node、CLI、state 路径均填写**接收端**的真实路径；服务文件内容不随卡片传输。

**Linux/macOS → Windows Kimi：** `--shell powershell` 描述 SSH 传输所用壳，`--kimi-service-file` 指向 Windows 的私有描述文件。

```bash
agent-dialogue node peer add --file '/ABS/PAIRING/windows-card.json' \
  --ssh win-peer --shell powershell --ledger embedded \
  --executable 'D:/Tools/agent-dialogue/runtime/node.exe' \
  --cli 'D:/Tools/agent-dialogue/app/bin/agent-dialogue.mjs' \
  --state-dir 'D:/Tools/agent-dialogue/spaces/project-a' \
  --cache-dir 'D:/Tools/agent-dialogue/cache' \
  --kimi-service-file 'D:/Tools/agent-dialogue/private/kimi-service.json'
```

**Windows → Linux 服务器 Kimi：** 接收端传输使用 `--shell posix`。

```powershell
agent-dialogue node peer add --file 'D:/Tools/agent-dialogue/pairing/server-card.json' `
  --ssh server-peer --shell posix --ledger embedded `
  --executable '/ABS/GLOBAL_USER/agent-dialogue/runtime/node' `
  --cli '/ABS/GLOBAL_USER/agent-dialogue/app/bin/agent-dialogue.mjs' `
  --state-dir '/ABS/GLOBAL_USER/agent-dialogue/spaces/project-a' `
  --cache-dir '/ABS/GLOBAL_USER/agent-dialogue/cache' `
  --kimi-service-file '/ABS/GLOBAL_USER/agent-dialogue/private/kimi-service.json'
```

若回程需要非默认 SSH 配置，加 `--ssh-config` 并填写**发起这条 SSH 的机器**上的配置路径。FRP / ZeroTier 提供可达性，仍需双向路由和主机密钥校验；本工具不自动增加公网 Kimi API 或中继。

## 6. 给每个 Kimi 聊天它自己的指南

共同 room 接受后，在该聊天所在机器生成精确说明：

```bash
agent-dialogue agent-guide --room r_FULL_ROOM_ID --from kimi-server --to peer-agent
```

把输出交给 `kimi-server` 对应的原生聊天，让它明确读取。Windows 的 alias 可改为 `kimi-windows`。同一份 self 指南不能给所有 agent 共用；保留准确 room、自己的 from、对端 expected-session 和完整环境前缀。

**Kimi 原生 Bash 工具使用 POSIX 语法，包括 Windows。** 使用生成的本聊天命令，不因 Windows SSH 配置为 PowerShell 而把 agent 的 Bash 命令改成 `$env:...`。例如 POSIX 的单引号、环境前缀、Windows `D:/...` 绝对可执行路径均按生成结果保留。原生 Bash 工具参数是 `command`；审批仍由原生 Kimi 权限机制处理。

指南使用 `collab send --queue` 将 agent 请求写入本机通信账本，由后台 worker 负责原生 API 和 SSH。它需要原生 shell 对 state 有既有写权限；安装规则文件不会扩大权限。操作者发起项目任务用 `--from operator` 的正常发送形式，跨机回复保留收到的全局 `--reply-to m_...`。

查看实际交流使用 `agent-dialogue view`；聚合其他节点采用显式只读 SSH 观察配置，见 [VIEWER.md](VIEWER.md)。查看器只展示实际进入 room 的消息与回执，不导入 Kimi 的所有原生聊天。

## 7. 忙碌、结果不确定与停止

| 结果 | 正确理解与处理 |
|---|---|
| `waiting-native` | 原生会话忙、等待审批/问题或已有队列；保留本地事件，等待原生状态恢复 |
| `queued` | agent 请求写入本地账本，还不是对端原生受理证明 |
| `remote-stored` | 对端通信账本收妥，尚未证明模型完成 |
| `admitted` / `native-admitted` | 精确原生 user 输入的 ID 和完整文本已核验；继续等待实际关联回复 |
| `unknown` / pending | POST 可能已生效；保留原 ID 和 state，先对账，不新发相同正文 |

本版本只在原生空闲时提交，`queue:false`。Kimi 自身支持队列，但其内存接受回执不被当作持久证据。适配器确认精确 `/messages/{inputId}` 的同一会话、user 角色、单一完整文本后才报告受理。网络错误、超时、重复 ID 冲突或 POST 成功本身不能替代该核对，也不能证明模型已经回复。

停止当前桥接：

```bash
agent-dialogue detach kimi-server
```

Windows 对应 `detach kimi-windows`。原生聊天及历史保留；Kimi 服务生命周期独立，不由 detach 关闭。重新接入选新 alias，重新交换卡片/建立共同 room/生成指南。原生服务重启生成新的 `server_id`、会话迁移、目录改变或允许清单改变时，需要重新核验描述与绑定；不猜测替换原绑定数据。

## 8. 固定协议来源与验证范围

适配器核验了官方 `@moonshot-ai/kimi-code@2.1.1` 提交 `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f` 与 `2.2.0` 提交 `472192c34c1efad89a369870eff0da0b708ce9bb`。其他版本拒绝接入，待协议及实机检查后再扩展。

- [官方服务 API 文档](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/docs/en/reference/server-api.md)：回环、认证、业务 envelope、会话与 prompt 入口；API 为实验接口。
- [2.1.1 prompt 路由](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/kap-server/src/routes/prompts.ts)：客户端 prompt ID、队列、请求字段和接受语义。
- [2.2.0 messageHistory](https://github.com/MoonshotAI/kimi-code/blob/472192c34c1efad89a369870eff0da0b708ce9bb/packages/kap-server/src/services/messages/messageHistory.ts) 与 [2.1.1 loopService](https://github.com/MoonshotAI/kimi-code/blob/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f/packages/agent-core-v2/src/agent/loop/loopService.ts)：Wire 刷新、持久 user 消息与稳定输入 ID；实际消息 `id` 是核对依据。
- [2.2.0 原生 Bash 工具](https://github.com/MoonshotAI/kimi-code/blob/472192c34c1efad89a369870eff0da0b708ce9bb/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts)：原生 shell 与 Windows 路径转换。

当前 17 项 adapter 单元测试覆盖身份与版本、精确范围、禁止 ID 类型转换、忙碌和审批、完整输入回执、响应丢失、ID 冲突、错误正文不泄露和描述文件变化。它们不调用模型。Windows / Linux 服务器的独立原生服务、真实模型回复、原生工具发信、跨机签名链路与拒收门禁均已完成；它们沿用不同的原有模型配置，验证的是 Kimi Code harness。全量 457 项测试与打包检查另行通过。完整身份、正文和连接留在私有记录，公开结果见 [Kimi 验收记录](../verification/kimi-integration-20261019-v2/README.md)。
