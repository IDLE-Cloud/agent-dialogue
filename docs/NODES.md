# 跨电脑、跨 harness 的节点通信

本文对应 v0.3 开发版。公开稳定 Release v0.2.0 尚无 `node` 命令；在开发分支合并或新版本正式发布前，两端需要安装同一开发分支或同一已核对提交：

```sh
npm install -g 'git+https://github.com/IDLE-Cloud/agent-dialogue.git#codex/multinode-adapters'
agent-dialogue setup
agent-dialogue doctor
```

上面的分支用于当前开发验收；长期部署应在验收后改为固定的发布版本或提交。

每台电脑运行一份 agent-dialogue，保存自己的节点密钥、hcom 消息账本和会话绑定。消息通过已有 SSH 通道进入对端的 `node receive`，由对端本地 adapter 交给固定的原生聊天。本工具不新增监听端口或网络服务；SSH 服务和各 harness 的本地运行环境需要预先配置好。

当前传输面是 POSIX SSH stdio，适用于 Linux、macOS 和明确配置的 WSL 环境。原生 Windows cmd/PowerShell 接收命令尚未适配。ZeroTier 可以承载已有 SSH 连接；它只负责网络可达性，节点和会话身份仍由下面的配对与绑定检查确认。

`--local` 使用本机子进程模拟另一节点，仅用于两个独立状态目录之间的集成测试。这样的结果应标为本机双节点验证。

## 先认识四种身份

| 身份 | 用途 |
|---|---|
| 节点 `n_…` | Ed25519 公钥的 SHA-256 标识，固定一台逻辑节点的签名身份 |
| binding `b_…` + revision | 固定 harness、原生 session/thread ID、服务身份、项目和工作目录 |
| room `r_…` + revision + manifest hash | 由 room owner 签名，固定参与者的 node ID、binding ID、revision 和 alias |
| 消息 `m_…` | 全局消息 ID，用于跨节点回复、去重和提交结果对账 |

alias 方便人和模型寻址。配对和投递仍检查完整的 node/binding/session 身份及版本。参与者在同一通信空间内需要使用不同 alias；遇到冲突时，先给会话选择新的 alias，再导出卡片和建立 room。

一个已有聊天可以参与多个 room，继续使用自身上下文。room 固定协作关系，不会隔离或复制聊天记忆。每台机器只调用自己的本地 harness adapter；远端不会直接访问本机 OpenCode 的 loopback API 或读取本机模型凭据。

## 两台电脑如何配对

先按照[安装说明](../README.md)在两端安装、运行 `agent-dialogue setup` 和 `agent-dialogue doctor`，并验证用于通信的 SSH alias 可以免交互登录。SSH 传输保留正常的主机密钥检查，使用 `BatchMode=yes`、`ConnectTimeout=8`。

在 A 端初始化节点、列出并接入指定已有聊天：

```sh
agent-dialogue node init --name computer-a
agent-dialogue sessions opencode
agent-dialogue attach opencode --session ses_ACTUAL_A --alias project-a
```

在 B 端执行对应操作，使用不同的 alias：

```sh
agent-dialogue node init --name computer-b
agent-dialogue sessions opencode
agent-dialogue attach opencode --session ses_ACTUAL_B --alias project-b
```

`attach` 使用完整原生会话 ID。各 harness 的接入能力和进程恢复条件见[兼容性说明](COMPATIBILITY.md)。

双方分别导出自己签名的节点卡片，并通过已有 SSH/scp 或其他可信渠道传递给对方：

```sh
mkdir -p "$HOME/.local/state/agent-dialogue/pairing"
chmod 700 "$HOME/.local/state/agent-dialogue/pairing"
agent-dialogue node export > "$HOME/.local/state/agent-dialogue/pairing/card-a.json"
```

B 端导出为 `card-b.json`。双方核对实际节点 ID 和来源，然后各自导入对方的卡片。卡片含公钥、签名和当前活动会话的绑定描述，也含项目目录等元数据，应保存在私有位置，通过可信渠道传递。

A 端保存到 B 端的固定 SSH 路由：

```sh
agent-dialogue node peer add \
  --file "$HOME/.local/state/agent-dialogue/pairing/card-b.json" \
  --ssh computer-b \
  --executable /usr/local/bin/node \
  --cli /opt/agent-dialogue/bin/agent-dialogue.mjs \
  --state-dir /home/USER/.local/state/agent-dialogue/spaces/default \
  --cache-dir /home/USER/.cache/agent-dialogue
```

这里的 `--executable`、`--cli`、`--state-dir`、`--cache-dir` 都是 **B 端的绝对路径**。按实际安装位置替换示例值。`--ssh` 使用本机已配置的 SSH alias，或简单的 `user@host`；端口和跳板配置写进私有 SSH 配置。

B 端以同样方式导入 `card-a.json`，保存到 A 端的 SSH 路由。若对端使用非默认 OpenCode 服务凭据文件或 Codex 数据目录，可以增加：

```sh
--service-file /home/USER/.local/state/opencode/service.json
--codex-home /home/USER/.codex
```

这些也是对端路径。凭据文件内容不会随卡片传递；它由对端的本地 adapter 读取。双方各自保留自己的签名私钥，通过卡片固定对方公钥。

每次接收时只执行已经保存的固定程序和 `node receive`。请求正文与签名通过 stdin 传入，不拼入远程 shell；响应通过 stdout 返回。单次请求/响应限制为 256 KiB，执行超时为 20 秒。

跨节点frame和本地排队请求在进入hcom前，另有120000字节的UTF-8编码上限，以兼容Linux单个命令参数限制。签名封装会重复正文并加入元数据；按编码后的整体frame计算，不只按字符数计算。超限在写入inbox/outbox intent前拒绝。

## 建立共同的 room

双方完成配对后，在 A 端创建 room。A 成为这个 room 的 owner：

```sh
agent-dialogue room create --name project-review --members project-a,project-b
agent-dialogue room export r_ACTUAL_ROOM > "$HOME/.local/state/agent-dialogue/pairing/room.json"
```

把 `room.json` 通过可信渠道传给 B，在 B 端导入：

```sh
agent-dialogue room import --file "$HOME/.local/state/agent-dialogue/pairing/room.json"
```

manifest 由 room owner 签名。接收端要求 owner 已配对，并确认每个成员与本机或已配对 binding 完全匹配，且至少包含一个本机参与者。相同 room ID 携带不同 manifest 会被拒绝。绑定失效、重新接入会话、项目目录变化或成员版本变化后，需要明确建立新的有效协作关系。

开始项目协作：

```sh
agent-dialogue collab send \
  --room r_ACTUAL_ROOM \
  --from operator \
  --to project-a \
  --message '请结合已有项目上下文，与 project-b 讨论方案边界，再汇总判断。'
```

原生聊天收到消息时会附带 room、发送方、全局消息 ID 和绝对路径 CLI 示例。agent 可以主动向其他参与者发送问题；回复使用收到的全局 ID：

```sh
agent-dialogue collab send \
  --room r_ACTUAL_ROOM \
  --from project-b \
  --to project-a \
  --reply-to m_ACTUAL_MESSAGE_UUID \
  --message '这是针对原问题的项目回复。'
```

回复必须属于同一 room，并反向对应原消息的两名参与者。数字 hcom event ID 只在各自本地账本内有效；跨节点使用全局 `m_…` ID。

## 回执、失败与恢复

```sh
agent-dialogue node status
agent-dialogue bindings
agent-dialogue bridge status
```

`node status` 返回 `{node, peers, inbox, outbox}`。inbox/outbox 以全局 message ID 为键，保存 payload hash、room、状态、节点和本地/远端事件 ID 等控制元数据，正文继续保存在 hcom 账本。

| 状态或证据 | 可以得出的结论 |
|---|---|
| 本地 outbox 已入账 | 本机保存了此次发送意图与可恢复的消息正文 |
| 对端签名 `stored`，发送端显示 `remote-stored` | 对端接收门禁通过，并保存到对端 hcom 账本 |
| bridge 的原生受理记录 `native-admitted` | 固定原生聊天的接口已接收该输入 |
| 实际模型回复 | 模型已经处理并作出回复，可继续核对其项目内容 |

`stored` ACK 不代表原生聊天已经受理，也不代表模型读过或完成了工作。SSH 已返回但 bridge 暂停时，消息可以停留在对端账本，等待正确的本地 adapter 恢复。

受限模型shell可使用`collab send --queue`，只向本地账本提交请求，后台source worker执行相同的原生/节点校验和网络投递。Codex默认得到这种命令。此时`queued`只是本地请求回执，source worker的`forwarded`记录才关联实际消息；消息的`remote-stored`和对方模型回复仍分别核对。模型不需要直接访问SSH或原生loopback API，但必须能够写入当前通信目录。

网络中断、超时或响应丢失会留下 `unknown`。先检查两端节点、账本与 adapter 状态，再用原全局消息 ID 对账：

```sh
agent-dialogue node flush --message m_ACTUAL_MESSAGE_UUID
```

`node flush` 重用原始签名内容和 message ID。接收端对相同 ID、相同 payload hash 返回原回执，避免重复进入原生聊天；相同 ID、不同内容会拒绝。工具不会在未知结果下自动新建消息或盲目重发。不要把同一段正文再次 `collab send` 当作恢复，这会生成另一个全局 ID。

若状态为未提交的 `preparing`、缺少 event ID，或控制数据与账本不一致，需要显式检查和恢复；不要删除状态文件后重新发送来消除错误。

## 密钥、迁移和适用范围

- 节点私钥在本机状态目录的 `dialogue/node.json`，权限为 0600。每个逻辑节点独立生成；不要把该文件复制到另一台并行运行的电脑，也不要把整个 `.state`/用户状态目录当作多机共享数据库。
- 安装包和依赖缓存可以分别安装或缓存；原生聊天、模型认证和节点运行状态由每台机器自己保存。
- 新电脑运行 `node init` 生成新身份，重新接入当地原生聊天，再交换卡片与 room manifest。更换节点身份后，对方需要显式重新配对。
- 已有绑定的 alias 不能与导入的对端 alias 冲突。为不同参与者选不同 alias 后重新导出卡片。
- SSH 提供传输与主机认证；节点签名、已固定公钥和已接受 manifest 提供应用层核对。首次配对仍需要可信传递和身份核验。
- 当前没有额外网络监听服务、自动远程安装、跨用户权限托管、自动提升权限或完整会话历史迁移。原生 harness 的批准请求与权限保持由各自运行环境处理。

开发验证可运行 `node scripts/node-integration.mjs --help`。真实双机测试需要目标机器 SSH 可达，并在每台机器准备好工具和当地 harness。独立状态目录的本机验证和真实双机验证应分别记录。

2026-10-17 已完成[两独立本机节点的真实模型验证](../verification/node-integration-20261017-v1/metrics.json)：OpenCode 2.0.20、显式零价格模型 `opencode/deepseek-v4.1-flash-free`，9 项断言通过。两个已有聊天在接入前各自保存项目约束；模型发出请求和关联回复，综合双方上下文，双方获得 `remote-stored` 并正确关联全局消息 ID，所有测试 binding 最后已 detach。项目问答阶段用时约 18.7 秒。该验证使用 `local-process`，SSH 双机网络和远端平台仍需单独验收。

同日完成[带真实入口故障负例的第二轮验证](../verification/node-integration-20261017-v2/metrics.json)，17 项断言全部通过，项目问答阶段约 14.6 秒。对已确认的原消息再次 `node flush --message`，返回原远端事件；同 ID 改正文重新签名、篡改签名、已签名但未接受的 room 均被实际 `node receive` 拒绝。两端 inbox 的 event/input 映射、原生 user input 和 hcom 消息条数保持不变，双方原稳定输入 ID 的出现次数在前后均为 1。该轮的两个测试 binding 已 detach，第一轮记录保留。
