# Agent Dialogue 使用手册：选择已有聊天，让两台电脑的 agent 协作

适用日期：2026-10-19。OpenCode 双机例子的功能基线：`5c897a54cff1a8f58c90d53e3c11c6364dfbdf7e`，开发分支 `codex/multinode-adapters`。稳定版 v0.2.0 尚不包含本手册的多机与 Windows 功能。后续新增的 Kimi adapter 需使用包含该实现的新功能提交，见 [KIMI.md](KIMI.md)，不能使用此旧基线直接运行 Kimi 接入。

本手册以 **Mac OpenCode V2 ↔ Windows OpenCode 1.19.0 V1** 为完整例子。程序每台电脑安装一次；每个协作空间保存自己的 state；原项目和已有原生聊天保留在原处。以下 `/ABS/...`、`ses_FULL_...`、`r_REPLACE_...` 都是需要替换的值。创建 room、发送任务、attach 会改变运行状态；本手册中的命令是操作说明，阅读文件本身不执行它们。

| 你要做什么 | 从哪里开始 |
|---|---|
| 只看已经发生的对话 | 第 7 节 |
| 第一次连接两段已有聊天 | 第 1～5 节，按顺序执行 |
| 让 agent 知道怎么使用 | 第 6 节，逐聊天分配说明 |
| 停止、重新接入或排查 | 第 8 节 |
| 接入 Codex、同机或第三台电脑 | 第 9 节 |

## 1. 先选对四样东西

| 名称 | 含义 |
|---|---|
| 程序目录 | CLI 的安装位置；不必放进每个研究项目 |
| state / 通信空间 | 本机节点密钥、消息、绑定及回执的位置；切换 cwd 不会切换它 |
| 原生聊天 / session | agent 原本工作的那段聊天，必须选完整 ID 并核对服务与项目目录 |
| room | 固定哪些绑定一起协作；不是新聊天，也不复制或隔离原聊天上下文 |

先按 [Windows 安装说明](WINDOWS.md)准备私有 Node 24、程序、loopback V1 服务和私有服务描述。Mac 的 OpenCode V2 服务也须正常运行并已配置模型。服务描述包含本机认证，路径可以传给 CLI，内容不发给另一台机器。

Windows 的 `opencode-v1` 与 Mac 的 `opencode` 是不同适配器。`opencode` 始终指向 V2。同一个原生 session 只交给一套活动桥接驱动；不要让独立 serve 与另一个工作的 TUI 同时驱动它。

两端必须已有可免交互的双向 SSH：Mac 用 `win-peer`，Windows 用私有 SSH 配置中的 `mac-peer`。FRP、ZeroTier 负责网络；A 能登录 B 不代表 B 已有回程。先按现有网络说明配置 SSH，保持主机密钥校验。

Mac 需要 Node22.13 或更新的受支持版本；这套已验证环境使用 Node26。未安装程序时，可在选择的工具位置克隆并固定功能基线：

```bash
git clone --branch codex/multinode-adapters \
  https://github.com/IDLE-Cloud/agent-dialogue.git /ABS/MAC_TOOLS/agent-dialogue
git -C /ABS/MAC_TOOLS/agent-dialogue checkout --detach \
  5c897a54cff1a8f58c90d53e3c11c6364dfbdf7e
command -v node
```

把实际 Node 绝对路径填入后面的 `/ABS/MAC_NODE`。已有安装跳过 clone，先核对所用功能提交；不要为了读新文档改动正在运行的 checkout。新机器的完整安装与权限说明见 [README](../README.md)和 [Windows 指南](WINDOWS.md)。

## 2. 在两个终端选择本次通信空间

下列例子使用一个新空间 `project-a`，两端均选择已验证的 embedded 后端。已有 hcom 空间继续使用原后端；切换后端要选新空间。state、卡片和生成指南保存在私有目录，不加入公开 Git。

**Mac：**

```bash
adNode='/ABS/MAC_NODE'
adCli='/ABS/MAC_TOOLS/agent-dialogue/bin/agent-dialogue.mjs'
ad() { "$adNode" "$adCli" "$@"; }

umask 077
export AGENT_DIALOGUE_STATE_DIR='/ABS/MAC_STATE/project-a'
export AGENT_DIALOGUE_CACHE_DIR='/ABS/MAC_CACHE/agent-dialogue'
export AGENT_DIALOGUE_LEDGER=embedded
export AGENT_DIALOGUE_OPENCODE_SERVICE_FILE='/ABS/MAC_OPENCODE/service.json'

ad setup
ad doctor --json
ad node init --name mac-project-a
```

**Windows PowerShell：**

```powershell
$adUtf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $adUtf8
[Console]::OutputEncoding = $adUtf8
$OutputEncoding = $adUtf8

$adNode = 'D:/Tools/agent-dialogue/runtime/node-v24.22.0-win-x64/node.exe'
$adCli = 'D:/Tools/agent-dialogue/app/bin/agent-dialogue.mjs'
function ad {
  & $adNode $adCli @args
  if ($LASTEXITCODE -ne 0) { throw 'agent-dialogue 失败，请先检查上一条错误。' }
}
function Save-AdText([string]$Path, [string[]]$Text) {
  [IO.File]::WriteAllText($Path, ($Text -join "`n"), [Text.UTF8Encoding]::new($false))
}

$env:AGENT_DIALOGUE_STATE_DIR = 'D:/Tools/agent-dialogue/spaces/project-a'
$env:AGENT_DIALOGUE_CACHE_DIR = 'D:/Tools/agent-dialogue/cache'
$env:AGENT_DIALOGUE_LEDGER = 'embedded'
$env:AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE = 'D:/Tools/agent-dialogue/private/opencode-v1.json'

ad setup
ad doctor --json
ad node init --name windows-project-a
```

本手册后面的 `ad` 都是上面终端函数。新开终端要重新设置，或加载你自己保存的配置。安装时若提供了 `.ps1` 薄入口，它仍需要明确的 state 和 V1 服务描述；默认空间不等于旧测试空间。

每一步先确认成功再继续。`doctor` 通过只说明基础环境可用，不证明目标聊天已绑定。每个新逻辑节点在自己的 state 生成身份，不复制另一端的 `dialogue/node.json`。

## 3. 选择并绑定已有聊天

**Mac：**

```bash
ad sessions opencode --cwd '/ABS/MAC_PROJECT'
# 核对 sessions[].id、directory、projectId、model、服务身份。
MAC_SESSION='ses_FULL_MAC_ID'
ad attach opencode --session "$MAC_SESSION" --alias mac-agent
ad bindings
```

**Windows：**

```powershell
ad sessions opencode-v1 --cwd 'D:/Projects/ProjectA'
$winSession = 'ses_FULL_WINDOWS_ID'
ad attach opencode-v1 --session $winSession --alias windows-agent
ad bindings
```

使用完整 session ID，标题只辅助辨认。V1 聊天需已有明确 agent/model；归档或 revert 状态不接受投递。`attach` 绑定原聊天并启动 worker，不创建替代聊天。

`bindings` 返回 `{bindings:[...], rooms:[...]}`。本地绑定应 active，worker 应 ready/running。若提示“binding 已保存但 worker 未启动”，先看状态；修复原因后用 `ad bridge start ALIAS`，不要再次 attach 同一 alias。

## 4. 交换卡片，分别配置去对方的路由

**两端先导出各自的卡片。Mac：**

```bash
mkdir -p "$AGENT_DIALOGUE_STATE_DIR/pairing" "$AGENT_DIALOGUE_STATE_DIR/context"
ad node export > "$AGENT_DIALOGUE_STATE_DIR/pairing/mac-card.json"
```

**Windows：**

```powershell
$pair = Join-Path $env:AGENT_DIALOGUE_STATE_DIR 'pairing'
$context = Join-Path $env:AGENT_DIALOGUE_STATE_DIR 'context'
New-Item -ItemType Directory -Force -Path $pair, $context | Out-Null
Save-AdText (Join-Path $pair 'windows-card.json') (ad node export)
```

Windows PowerShell 5.1 的 `>` / `Out-File` 可能写出错误编码。签名 JSON 使用上面的无 BOM UTF-8 保存方式，不手工编辑卡片 payload。

**在 Mac 交换两份卡片：**

```bash
scp win-peer:D:/Tools/agent-dialogue/spaces/project-a/pairing/windows-card.json \
  "$AGENT_DIALOGUE_STATE_DIR/pairing/windows-card.json"
scp "$AGENT_DIALOGUE_STATE_DIR/pairing/mac-card.json" \
  win-peer:D:/Tools/agent-dialogue/spaces/project-a/pairing/mac-card.json
```

通过可信渠道核对卡片来源和节点 ID。`node export` 是签名信封，节点在 `payload.node`；`node status` 才是 `{node,peers,inbox,outbox}`。

**Mac 导入 Windows 卡片和路由：**

```bash
ad node peer add \
  --file "$AGENT_DIALOGUE_STATE_DIR/pairing/windows-card.json" \
  --ssh win-peer --shell powershell \
  --executable 'D:/Tools/agent-dialogue/runtime/node-v24.22.0-win-x64/node.exe' \
  --cli 'D:/Tools/agent-dialogue/app/bin/agent-dialogue.mjs' \
  --state-dir 'D:/Tools/agent-dialogue/spaces/project-a' \
  --cache-dir 'D:/Tools/agent-dialogue/cache' --ledger embedded \
  --opencode-v1-service-file 'D:/Tools/agent-dialogue/private/opencode-v1.json'
```

**Windows 导入 Mac 卡片和回程：**

```powershell
ad node peer add `
  --file (Join-Path $pair 'mac-card.json') `
  --ssh mac-peer --shell posix `
  --ssh-config 'D:/Tools/agent-dialogue/private/mac-ssh-config' `
  --executable '/ABS/MAC_NODE' `
  --cli '/ABS/MAC_TOOLS/agent-dialogue/bin/agent-dialogue.mjs' `
  --state-dir '/ABS/MAC_STATE/project-a' `
  --cache-dir '/ABS/MAC_CACHE/agent-dialogue' --ledger embedded `
  --service-file '/ABS/MAC_OPENCODE/service.json'
```

`--executable` 是接收端的 Node，`--cli` 是接收端的 `.mjs`，不能填写 `.ps1` wrapper。state/cache/service 也属于接收端。只有 `--ssh-config` 属于执行 SSH 的当前机器；它配置端口、密钥和已有跳板。路径必须是实际绝对路径，不在这些参数里使用 `~` 或 `$HOME` 期待远端展开。

## 5. 只在一端创建 room，另一端接受它

**Mac 创建一次，记下返回的 `.id`：**

```bash
ad room create --name project-a --members mac-agent,windows-agent
ROOM_ID='r_REPLACE_WITH_CREATED_ID'
ad room export "$ROOM_ID" > "$AGENT_DIALOGUE_STATE_DIR/pairing/room.json"
scp "$AGENT_DIALOGUE_STATE_DIR/pairing/room.json" \
  win-peer:D:/Tools/agent-dialogue/spaces/project-a/pairing/room.json
```

**Windows 导入同一份 manifest：**

```powershell
ad room import --file (Join-Path $pair 'room.json')
$room = 'r_REPLACE_WITH_CREATED_ID'
ad bindings
```

两端用同一个完整 `r_...` ID，不在两边各 create 一个同名 room。浏览器地址里的 `#room=room_...` 是查看器内部键，不能拿去给 CLI 的 `--room`。

## 6. 把专属说明交给每个 agent，再发项目任务

**Mac 生成自己的说明：**

```bash
ad agent-guide --room "$ROOM_ID" --from mac-agent --to windows-agent \
  > "$AGENT_DIALOGUE_STATE_DIR/context/mac-agent.md"
```

**Windows 生成自己的说明：**

```powershell
Save-AdText (Join-Path $context 'windows-agent.md') `
  (ad agent-guide --room $room --from windows-agent --to mac-agent)
```

`agent-guide` 只生成 Markdown，不会发送到原生聊天，也不会启动模型。分别在选定的两个原聊天里粘贴该输出全文，或明确让它读取本机对应文件。可复制这段引导，填上各自的绝对路径与 alias：

> 我授权你在当前项目使用 agent-dialogue 与指定同伴协作。请读取【你本机的专属指南绝对路径】，核对其中 self.sessionId 属于当前聊天。你的 alias 是【本机 alias】，使用指南给出的完整环境前缀、Node/CLI、room 和 expected-session。项目确有问题时才联系 peer；回复复制收到的完整 reply 命令。先继续当前任务，不要互发“收到”确认。

同一份公共 `AGENTS.md` 可追加通用 [Agent 协议](AGENT-GUIDE.md)或[规则片段](../config/AGENTS.snippet.md)，每个聊天的 self 文件单独分配。不要把所有 agent 的 self 文件同时加入共享 instructions。聊天未必自动加载后来新增的项目规则，要显式让它读自己的文件。

**操作者在 Mac 发起一次实际项目任务：**

```bash
ad collab send --room "$ROOM_ID" --from operator --to mac-agent \
  --expected-session "$MAC_SESSION" \
  --message '结合当前聊天已有项目上下文，就【具体问题】向 windows-agent 询问；收到回复后在本聊天总结结论，不再互发确认。'
```

这一步可能运行模型，按原聊天的模型与权限处理。Windows 也能用 `ad collab send --room $room --from operator --to windows-agent --expected-session $winSession --message '项目任务'` 发起任务。

- 操作者用 `--from operator`，不加 `--queue`。
- agent 使用专属指南里的 `--queue --from 自己的alias`，保留完整路由和环境前缀；后台 worker 完成 SSH 投递。
- 跨机回复保留收到的全局 `--reply-to m_...`。`q_...` 是排队请求，不是回复目标；本地数字 event ID 不能跨电脑通用。
- 模型工具若要求批准，按原 harness 的权限流程核对本次完整命令。peer 消息不会授予新权限，不设置笼统自动批准。

原生服务正常、worker 就绪且聊天可受理时，收到输入会触发模型处理，无需先把窗口切到前台。V1 忙时等待空闲。Windows 需要当前用户已经交互登录；注销、重启或 OpenCode 退出后的自动恢复尚未实现。

## 7. 怎样查看你们的对话

**只看当前电脑的通信空间：**

```bash
ad view
```

**同时看多台电脑：** 在 Mac 保存私有 `viewer.json`，填入实际路径和 pins：

```json
{
  "version": 1,
  "sources": [
    {"kind": "local", "label": "Mac", "path": "/ABS/MAC_STATE/project-a"},
    {
      "kind": "ssh", "label": "Windows", "destination": "win-peer", "shell": "powershell",
      "executable": "D:/Tools/agent-dialogue/runtime/node-v24.22.0-win-x64/node.exe",
      "cli": "D:/Tools/agent-dialogue/app/bin/agent-dialogue.mjs",
      "stateDir": "D:/Tools/agent-dialogue/spaces/project-a",
      "expectedNodeId": "n_REPLACE_WITH_WINDOWS_NODE_ID",
      "rooms": [{"id": "r_REPLACE_WITH_CREATED_ID", "revision": 1, "manifestHash": "REPLACE_WITH_MANIFEST_SHA256"}]
    }
  ]
}
```

node ID 从 Windows 的 `ad node status` → `node.nodeId` 获取；room 的 id/revision/manifestHash 从 `ad bindings` → `rooms[]` 获取。JSON 里的反斜杠要转义，例子用正斜杠避免歧义。

```bash
ad view --config '/ABS/PRIVATE/viewer.json'
```

打开终端打印的**完整访问链接**，包含随机端口和访问 token。链接用于运行查看器的这台电脑；另一浏览器需重新打开当前运行实例打印的完整含 token 链接；服务重启后使用新打印的链接。查看器 JSON 不接受 `sshConfig`、serviceFile、cacheDir 或任意 SSH 参数，`destination` 必须能用查看器启动环境的默认 SSH 配置解析。

页面能看消息正文、准确会话、回复定位、排队/转发/收妥/受理证据，并导出 JSON 或 Markdown。它展示实际发送到 room 的通信，不是所有 harness 的完整聊天或内部思考。查看不会唤醒模型、重试消息或改变通信进度；关闭浏览器或查看器不会停止 agent 通信。

## 8. 状态、停止和重新接入

```bash
ad bindings
ad bridge status
ad node status
ad history --last 30 --thread "$ROOM_ID"
```

Windows 的 history 把 `"$ROOM_ID"` 换成 `$room`。需要严格只读地查看源文件时使用 viewer。

| 看到的状态 | 说明与操作 |
|---|---|
| `queued` | 本地请求保存了；检查本机 source worker，不再次发送同正文 |
| `forwarded` | 本地请求已关联实际发送结果 |
| `remote-stored` | 对方账本保存了；尚不能证明模型已完成 |
| `admitted` / `native-admitted` | 准确原生聊天受理了输入 |
| 实际关联回复 | 对方发回针对原消息的答复，结合内容判断任务完成情况 |
| `waiting-native` | V1 聊天忙，等待其空闲 |
| `unknown` / pending | 保留原状态与 ID，先对账；不要删除 state 或新发同正文 |

已有跨机消息经操作者核对后可用 `ad node flush --message m_ORIGINAL_MESSAGE_ID` 重试/对账原 ID。它不是重新 `collab send`，也不用于尚未获得正式消息 ID 的 `q_...`。

停止桥接：`ad detach mac-agent` 或在 Windows `ad detach windows-agent`。原生聊天和历史保留，Windows worker 会核对并清理自己的任务。detach 是分离绑定，旧 alias 不再启用，`bridge start` 不能使它重新 active。

要继续使用已 detach 的同一原生聊天：使用**新 alias** attach 原 session → 双方重新导出/导入卡片 → 创建并接受**新 room** → 重新生成专属指南。程序和旧历史不必删除，已有 state/node 可继续保留。

如果绑定仍 active，只是 worker 未启动，在原生服务恢复且没有未处理 unknown/pending 后，可用 `ad bridge start ALIAS`。服务身份改变、目录或会话不匹配时重新核对绑定，不靠猜测替换它们。

## 9. 同机、Codex 和更多电脑

- **同机两个聊天**：同一 state 下分别 attach，不做 SSH/卡片交换；直接 create room，再分别生成指南。两个不同 state 即使在同一电脑，也属于不同节点流程。
- **Mac/Linux Codex**：可在第 3 节改用 `ad sessions codex --cwd /absolute/project`，再 `ad attach codex --session FULL_THREAD_UUID --alias codex-agent`。原 thread 未加载时，只有明确选择同一个 UUID 后才加 `--resume`。Codex 的通信 state 需处在该聊天原本允许写入的范围内；当前活跃 Desktop 聊天和 Windows Codex 不能据此推定已接入。完整前置条件见 [兼容性说明](COMPATIBILITY.md)。
- **第三台电脑**：单独安装相同功能版本、自己的 state/node、接入本机已有聊天。每个参与节点先导入其他所有成员节点的卡片，并保存各 peer 的固定路由；实际直接收发的方向要能通过 SSH 到达，当前没有自动中继。room owner 汇总全部成员并签名，各参与节点接受同一 manifest；为每个本机 agent 生成它自己的指南。
- **Kimi Code 2.1.1 / 2.2.0**：开发分支已新增 `sessions kimi` / `attach kimi`，需先配置 `AGENT_DIALOGUE_KIMI_SERVICE_FILE`，跨机路由带接收端 `--kimi-service-file`。只接入选定原生 Web 服务拥有的准确聊天；Windows 的 Kimi Bash 使用 POSIX 语法。adapter 单元测试与 Windows / Linux 服务器各自对 Mac OpenCode 的受控双向真实通信均已通过。安装、会话允许清单、服务器 `global_user` 目录与完整操作见 [KIMI.md](KIMI.md)。
- **Pi/ZCode**：通用协议可以让它们知道规则，严格已有聊天自动收消息仍需各自 adapter；以已验证能力为准。此前 Windows 实机记录对应 OpenCode 1.19.0 V1。

详细参考：[Windows 部署](WINDOWS.md)、[节点与恢复](NODES.md)、[Agent 协议](AGENT-GUIDE.md)、[查看器](VIEWER.md)、[参数配置](CONFIGURATION.md)。
