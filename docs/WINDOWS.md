# Windows 原生节点接入

本文对应 `codex/multinode-adapters` 开发分支。稳定 Release `v0.2.0` 不包含这里的 Windows 功能。Windows 路径使用原生 Node、OpenSSH、PowerShell 与 OpenCode V1，已有 FRP 可以继续承载 SSH；不需要启动 WSL。

Windows 支持包含独立通信账本、固定 PowerShell 接收命令、当前用户 worker 生命周期、只读查看器来源和 OpenCode `1.19.0` 的准确已有会话适配。测试合同与实际部署证据分别记录：本页给出安装和验收方法，不代表任意原有 TUI 窗口已经接入，也不预先声称真实多轮模型验收通过。

## 程序、状态与原项目

每台电脑安装一份程序，为每个通信空间准备自己的状态目录。原来的项目目录、原生聊天和模型账号保留在原位置。例如：

```text
C:\AgentDialogue\
├── app\                            固定提交的 agent-dialogue 程序
├── runtime\node-v24.22.0-win-x64\   独立 Node，不覆盖系统 Node
├── cache\                          工具缓存
├── private\                        私有服务描述与节点卡片
└── spaces\project-a\               该逻辑节点的身份、账本和绑定

D:\Projects\ProjectA\              原来的项目文件
```

路径均为示例。源码只需安装一次，各研究项目无需复制一份程序。活动状态目录不能在多台机器之间共用，不能把别的运行节点的密钥复制过来充当新节点。

使用支持 `node:sqlite` 的 Node 24。Windows 默认使用 `embedded` 账本，不下载上游 hcom 二进制，也不冒充 hcom 的完整功能。该账本仅实现准确会话桥接所需的注册、消息、历史、游标和有界等待，复用现有节点签名、room、回执和查看器。上游 hooks、`launch`、原始 hcom 命令、relay 等入口不属于这个 Windows 后端。

## 安装开发版

先为新安装创建专用私有目录。下面的 PowerShell 片段使用当前用户的 `LOCALAPPDATA`；它仅适用于尚不存在的新目录。已有安装先核对其 ACL，不用这段代码重置原目录。

```powershell
$adRoot = Join-Path $env:LOCALAPPDATA 'agent-dialogue'
if (Test-Path -LiteralPath $adRoot) { throw '该目录已存在，请先核对原安装和 ACL。' }
[IO.Directory]::CreateDirectory($adRoot) | Out-Null
$adSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$adAcl = [Security.AccessControl.DirectorySecurity]::new()
$adAcl.SetOwner($adSid)
$adAcl.SetAccessRuleProtection($true, $false)
$adRule = [Security.AccessControl.FileSystemAccessRule]::new(
  $adSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
)
$adAcl.AddAccessRule($adRule)
Set-Acl -LiteralPath $adRoot -AclObject $adAcl
```

随后在这个目录中安装运行时和程序，账本、服务描述及新文件继承当前用户的私有 ACL。节点密钥和 worker launch 目录还会进行各自的校验；工具不会自动收紧任意外部账本目录或服务描述文件。

从 [Node.js 官方下载页](https://nodejs.org/en/download) 选择固定的 Windows x64 Node 24 ZIP，并核对同版本官方校验文件。解压到用户选择的私有工具目录，不需要覆盖 PATH 中已有的 Node 20，也不需要修改其它 agent 的启动方式。

在 PowerShell 中设置本轮工具路径。所有例子都显式调用独立 Node：

```powershell
$adRoot = Join-Path $env:LOCALAPPDATA 'agent-dialogue'
$adNode = Join-Path $adRoot 'runtime\node-v24.22.0-win-x64\node.exe'
$adCli = Join-Path $adRoot 'app\bin\agent-dialogue.mjs'

git clone --branch codex/multinode-adapters `
  https://github.com/IDLE-Cloud/agent-dialogue.git `
  (Join-Path $adRoot 'app')

# 实际部署应固定经过检查的完整提交，并保留版本记录。
git -C (Join-Path $adRoot 'app') rev-parse HEAD

$env:AGENT_DIALOGUE_STATE_DIR = Join-Path $adRoot 'spaces\project-a'
$env:AGENT_DIALOGUE_CACHE_DIR = Join-Path $adRoot 'cache'
$env:AGENT_DIALOGUE_LEDGER = 'embedded'

& $adNode $adCli setup
& $adNode $adCli doctor --json
& $adNode $adCli node init --name windows-project-a
```

`setup` 初始化独立的 SQLite 账本。已存在的上游 hcom 数据库和其它未知数据库会被拒绝，不能原地当作 embedded 账本继续写入。升级程序时保留状态，切换账本后端时使用另一个明确的通信空间。

Windows 文件权限以 ACL 为准。部署目录中的私钥、服务凭据和 worker 描述文件需要按工具要求限制给当前用户；不能用 Unix `0600` 显示值替代 Windows ACL 检查。服务描述、卡片、生成的聊天说明和完整诊断保存在私有目录，不加入仓库。

## 选择 OpenCode V1 服务与已有聊天

使用 `opencode-v1` 适配器选择 OpenCode **1.19.0**。普通 `opencode` 别名仍指向 V2，两者 API 与服务描述格式不同。

先明确这段聊天属于哪个原生服务。该服务必须只监听 loopback，并提供本机 Basic auth；不要经 FRP 对外公开模型 API。工具不自动启动 OpenCode、不修改全局模型或权限、不为接入创建替代聊天。

V1 服务可以由独立交互窗口或经检查的当前用户任务启动。它的有效 `config.shell` 必须明确使用 PowerShell，并与下面的描述一致。对现有共享服务只检查配置，不强行更改 shell。验收专用服务可在自己的进程级配置固定 shell 与 `bash: ask`，保留原有用户文件和模型凭据。

创建 owner 选择的私有 V1 服务描述，例如 `C:\AgentDialogue\private\opencode-v1.json`：

```json
{
  "id": "OWNER_GENERATED_SERVICE_INSTANCE_ID",
  "url": "http://127.0.0.1:49375",
  "version": "1.19.0",
  "username": "opencode",
  "password": "LOCAL_SERVICE_PASSWORD",
  "directory": "D:\\Projects\\ProjectA",
  "projectId": "EXACT_NATIVE_PROJECT_ID",
  "commandShell": "powershell",
  "shell": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
}
```

这些字段由本机操作者配置。`projectId`、目录与 session ID 来自选定原生服务的只读元数据，不使用项目名称或聊天标题代替。适配器每次检查服务版本、描述身份、项目、目录和有效 shell；原生 V1 本身没有进程实例 nonce，因此服务重启后操作者需要更新 owner 描述身份并重新核验绑定。

Windows PowerShell 5.1 的 `>` 和部分 UTF-8 文件写入方式会附加 BOM。通过 PowerShell 保存供 CLI 读取的 JSON 时，用无 BOM UTF-8：

```powershell
# $record 是操作者按上面 schema 准备的对象，含本机私有凭据。
$serviceFile = Join-Path $adRoot 'private\opencode-v1.json'
[IO.File]::WriteAllText(
  $serviceFile,
  ($record | ConvertTo-Json -Depth 8),
  [Text.UTF8Encoding]::new($false)
)
$env:AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE = $serviceFile

& $adNode $adCli sessions opencode-v1 --cwd 'D:\Projects\ProjectA'
& $adNode $adCli attach opencode-v1 --session ses_FULL_NATIVE_ID --alias windows-a
& $adNode $adCli bindings
& $adNode $adCli bridge status
```

必须把示例 `ses_FULL_NATIVE_ID` 换成清单中完整的真实 ID。服务上的原 session 必须已有明确的 agent/model。发送时沿用它们及原 variant，不发送覆盖工具或权限的字段；归档或处于 revert 状态的聊天会拒绝投递。

独立 `serve` 能读取同一 profile 的已保存 session，并不证明它已经接管另一个仍在工作的 TUI。接入正在使用的旧聊天前，需要确定准确服务、会话以及它的空闲/占用情况；不要让两个服务同时驱动同一个原 session。对话列表里有某个标题也不代表对应窗口已被唤醒。

## Windows worker 的运行与停止

`attach` 为该绑定启动一个 **当前用户、Limited、InteractiveToken、无触发器** 的计划任务。任务的 Exec action 直接运行固定 Node 和 worker；使用计划任务是为了让 worker 不随一次 SSH 会话结束。它不保存 Windows 登录密码、不请求管理员、不设置登录或开机触发器，也不覆盖同名任务。

worker 的 launch 描述只保存经允许的通信环境和绝对路径，不把模型 API key 或服务密码复制进去。服务密码仍在本机描述文件，worker 保存的是它的路径。

新任务会明确给当前用户 SID 配置该任务对象的访问权，使 Limited worker 能在退出时删除自己的任务。任务运行级别仍是普通用户；不修改全局任务权限。

```powershell
& $adNode $adCli bridge status
& $adNode $adCli detach windows-a
```

`detach` 标记绑定停止，由 worker 退出并检查自己的任务定义后清理；不停止原 OpenCode 聊天。任务所有权不一致或调度结果不确定时保留证据，等待操作者检查，不终止其它用户的进程或任务。日志在当前 state 的 `dialogue\b_….worker.log`，launch 描述在 `dialogue\windows-workers\`。

这版要求当前用户已有交互登录。Windows 重启、用户注销、计划任务不可用及 harness 进程退出后的自动恢复仍需进一步实现与验收，不能按无人登录的常驻服务使用。后台任务存在也不等于原生模型或通信回程健康，状态需要分别检查。

## 通过已有 FRP SSH 配对

先核对现有 SSH 入口，例如在控制电脑上运行 `ssh win-frp`。FRP 承载 OpenSSH，agent-dialogue 再通过固定 `node receive` 交换签名消息；消息正文经 stdin 发送，不拼接进 PowerShell 程序。

Mac/Linux 端保存 Windows 节点卡片后，配置 Windows 路由：

```sh
agent-dialogue node peer add \
  --file /absolute/private/windows-card.json \
  --ssh win-frp \
  --ssh-config /absolute/private/ssh-config \
  --shell powershell \
  --executable 'C:/AgentDialogue/runtime/node-v24.22.0-win-x64/node.exe' \
  --cli 'C:/AgentDialogue/app/bin/agent-dialogue.mjs' \
  --state-dir 'C:/AgentDialogue/spaces/project-a' \
  --cache-dir 'C:/AgentDialogue/cache' \
  --opencode-v1-service-file 'C:/AgentDialogue/private/opencode-v1.json' \
  --ledger embedded
```

`--ssh-config` 是执行 SSH 的这台控制电脑上的绝对路径，包含端口、密钥及已有跳板；其余程序、state、cache、service 路径均是 Windows 端绝对路径。路径可以有空格；SSH 接收程序使用固定编码的 PowerShell 和 UTF-8，不依赖 cmd 的引用语法。保留主机密钥校验与 BatchMode，不把任意 SSH options 放进消息正文。

Windows 端同样需要到对方的明确回程。Mac 能经 FRP 登录 Windows，不代表 Windows 已能反向登录 Mac。可以复用已核验的直连或受限回程隧道，但需要操作者分别配置、核对并保存到 Windows 端的 peer 路由中。

双方各自导出签名卡片、导入对方，再创建/接受同一个 room，步骤见 [NODES.md](NODES.md)。在 PowerShell 中保存卡片也使用无 BOM UTF-8：

```powershell
$card = & $adNode $adCli node export
if ($LASTEXITCODE -ne 0) { throw 'Node export failed' }
[IO.File]::WriteAllText(
  (Join-Path $adRoot 'private\windows-card.json'),
  ($card -join "`n"),
  [Text.UTF8Encoding]::new($false)
)
```

## 给 agent 用法与查看记录

room 配置成功后，在 Windows 为准确的聊天生成自己的说明：

```powershell
& $adNode $adCli agent-guide --room r_ACTUAL_ROOM --from windows-a --to peer-a
```

生成的命令使用绑定中记录的 PowerShell、绝对 Node/CLI 路径和通信环境。把说明明确交给选定原聊天读取。保留全部路由值，仅替换消息正文；PowerShell 单引号字符串中的单引号写作 `''`。收到消息时优先使用其附带的完整回复命令，跨机回复保留全局 `--reply-to m_…`。

用本地 `collab send --queue` 写入通信账本后，worker 负责调用原生服务与 SSH。V1 没有可靠的原生 durable queue；忙碌时本地消息等待，不插入原生忙会话。原生 204 只表示开始后台处理，适配器要回查完整 user message 才记录受理。已有输入或结果不确定时按稳定 ID 对账，不盲目重新 POST。

控制电脑的查看器可增加一个固定 Windows 来源：

```json
{
  "version": 1,
  "sources": [{
    "kind": "ssh",
    "label": "Windows project",
    "destination": "win-frp",
    "shell": "powershell",
    "executable": "C:/AgentDialogue/runtime/node-v24.22.0-win-x64/node.exe",
    "cli": "C:/AgentDialogue/app/bin/agent-dialogue.mjs",
    "stateDir": "C:/AgentDialogue/spaces/project-a",
    "expectedNodeId": "n_ACTUAL_NODE_HASH",
    "rooms": [{"id": "r_ACTUAL_ROOM", "revision": 1, "manifestHash": "ACTUAL_MANIFEST_SHA256"}]
  }]
}
```

按真实 node/room 字段替换占位符，再运行 `agent-dialogue view --config /absolute/private/viewer.json`。查看器目前通过它启动时可用的默认 SSH 配置解析 `destination`，该 JSON 不接受 `sshConfig` 或任意 SSH 参数；`node peer add --ssh-config` 是通信路由的独立能力。查看器只读所选房间，不唤醒模型。完整观察说明见 [VIEWER.md](VIEWER.md)。

## 验收与当前范围

接入完成需要分别证明：SSH 可达、Windows 节点身份稳定、完整 session 正确、worker 在 SSH 断开后仍运行、双方消息进入准确原会话、关联回复返回、查看器能读到且不修改源记录。机器登录成功、CLI setup 成功或 API 返回 204 都不足以代替这些证据。

仓库的 Windows Node 24 CI 运行可移植的账本、平台、传输、worker、V1、观察和验收合同测试，并在独立目录执行 embedded setup/doctor；CI 不登录任何用户主机，不调用付费或免费模型，也不替代真实 FRP 多轮测试。

目前仅明确实现 OpenCode `1.19.0` V1 的这条原生路径。V2、Codex、Kimi、Pi 或 ZCode 在 Windows 上的既有聊天、任意活跃 TUI 接管、注销/重启自启、自动启动退出的 harness，都需要各自适配与验收。后续真实结果应附独立脱敏指标；完整原生 ID、机器路径和诊断继续保留在私有部署记录。

## 已完成的实机验证

2026-10-19 已完成 [Mac ↔ 原生 Windows 双向通信验收](../verification/windows-integration-20261019-v2/README.md)，21/21 项检查通过。两端模型各执行两条通信命令，产生4条全局签名消息和两组关联回复；接入的普通原生聊天保留。Windows为OpenCode1.19.0/Node24.22.0，Mac为OpenCode2.0.20，均使用核验零价格且实际cost0的模型。本轮命令与回复正文由owner测试fixture预先指定，验证消息链路和真实工具执行，不代表开放式自治协作质量评测。

[只读观察](../verification/windows-observer-20261019-v1/metrics.json)的8项检查通过：6条逻辑记录、4条跨机副本合并、2组回复引用，两侧各7个状态文件的字节哈希不变。[实际Limited任务生命周期](../verification/windows-lifecycle-20261019-v1/metrics.json)另有12项检查通过，证明注册SSH结束后任务独立启动、随后自行删除任务与启动描述。该修复单独验证，未把旧任务需要操作者清理的失败过程改写成自动成功。

本机全量427项、Windows原机基础集合97项、修复后的Windows worker专项12项及隔离安装包检查均通过。基础集合和修复专项分别保存结果。正式项目接入仍需操作者选择准确服务、目录和完整session ID；此次测试绑定最后已detach，不会持续向测试聊天投递。
