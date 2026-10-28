# Agent Dialogue Lite

Lite 把不同电脑、不同 harness 的已有聊天接入同一个项目讨论。一个 Hub 保存 SQLite 消息，每台电脑运行一个 Node；agent 通过四个工具收发，用户从 Hub 网页查看消息和回复。

这是独立的 `0.1.0` 开发包，命令 `adl`，数据目录 `agent-dialogue-lite`。安装不会转换现版 `agent-dialogue` 的数据。

首次使用可先读 [中文使用报告：Kimi 保留 TUI 的项目协作](docs/USAGE-REPORT-ZH.md)，其中包含从零配置、可直接给 agent 的指令、日常操作、多机接入和故障处理。

```text
Mac 已有聊天 ─ 本机 Node ─┐
                         ├─ HTTPS / SSH 隧道 ─ Hub + SQLite ─ 只读网页
Windows 已有聊天 ─ Node ──┘
```

## 当前能力

- 原生推送：OpenCode 2.0.20，OpenCode V1 客户端固定支持 1.19.0。连接进程按准确的服务、完整 session ID、project ID 和目录核验目标。V1 的实际本轮模型验证状态见验证报告，不能用协议测试代替。
- 通用收件：可执行 CLI 或配置 stdio MCP 的 harness 可使用 `context / send / inbox / status`。这条路径需要 agent 主动读 inbox，空闲模型不会因此自动唤醒。Kimi、Codex、ZCode 的 Lite 原生推送尚未接入。
- Kimi TUI 收信：`adl wait` 在原生后台 Bash 任务中等待来信，由 Kimi 自己的任务完成通知唤醒当前聊天，TUI 保持打开。首次启动和收到消息后重新挂接由当前 agent 执行，权限沿用原生规则。见 [Kimi TUI 指南](docs/KIMI-TUI.md)；这条工具收件路径不依赖 Kimi Web adapter。
- 同一台机的 Node 管理多段聊天；忙碌、等待审批、进程未运行时保留排队。原生提交结果不明时显示 `unknown`，阻塞该聊天后续自动推送，其他聊天继续。
- Hub 受理后持久保存；同 ID 同内容重试不会新增消息；回复用 `replyTo` 关联。`delivered` 代表原生服务受理，`tool-read` 代表工具读取，完成任务需要实际回复。
- Hub 网页只读，直接显示统一消息记录。浏览器查看不会给 agent 标已读。

Hub 需要在线，管理者可读取通信正文。发送端联系不到 Hub 时明确失败并返回原消息 ID；发送端没有离线发件箱。暂不自动拉起 harness、不提供远程 shell、不自动批准工具、不自动重投未知原生提交。

## 安装

每台机器需要 Node.js 24 LTS 或更高版本，以及需要连接的 harness。克隆到用户的工具目录即可，业务项目可以位于其他目录。

```bash
git clone --branch codex/lite https://github.com/IDLE-Cloud/agent-dialogue.git
cd agent-dialogue/packages/lite
npm install --global .
adl --help
```

Windows 同样使用以上命令，可在 PowerShell 运行。也可以用 `node /完整路径/packages/lite/bin/adl.mjs` 代替 `adl`；不必全局安装。不需要 Redis、hcom 或额外 npm 运行依赖。当前分支为开发版；多机使用时固定相同 commit。

## 在本机接入两个聊天

以下用 `operator.json / node-mac.json / chat-a.json / chat-b.json / viewer.json` 表示私有配置文件的绝对路径。默认目录是 macOS/Linux 的 `~/.local/state/agent-dialogue-lite`，Windows 的 `%LOCALAPPDATA%\agent-dialogue-lite`。每段聊天使用独立 scope 文件，勿把一个固定身份写进多个聊天共用的全局 MCP 配置。

1. 操作者初始化并启动 Hub。在第二个终端继续后续命令。

   ```bash
   adl init --config /私有目录/operator.json
   adl hub --config /私有目录/operator.json
   adl room --config /私有目录/operator.json --label my-project
   adl enrollment --config /私有目录/operator.json
   ```

   保存返回的 room ID。入网码有效期 10 分钟、只能使用一次。

2. 在这台机器登记 Node。填入入网码和 Hub 地址；第二台机器以后重复这一步即可。

   ```bash
   adl enroll --config /私有目录/node-mac.json --hub http://127.0.0.1:8417 --code CODE --label mac
   ```

3. 选定已有 OpenCode 聊天。服务凭据描述文件由 OpenCode 生成，常见位置为 `~/.local/state/opencode/service.json`。先列会话，再选择完整 ID，不能用标题或 `latest`。

   ```bash
   adl sessions --kind opencode --service-file /路径/service.json
   adl attach --config /私有目录/node-mac.json --kind opencode --service-file /路径/service.json --session ses_FULL_ID --alias reviewer
   ```

   保存返回的 agent ID。对另一段聊天重复 `attach`，同一个 Node 配置可管理两者。相同绑定只更新 alias，换聊天会生成新的 agent ID；旧消息保持原来的目标。

4. 操作者把 agent 加入 room，发放该聊天的工具配置，然后让 Node 关联这个配置。两段聊天各执行一次。

   ```bash
   adl join --config /私有目录/operator.json --room ROOM --agent AGENT_A
   adl scope --config /私有目录/operator.json --room ROOM --agent AGENT_A --out /私有目录/chat-a.json
   adl link-tools --config /私有目录/node-mac.json --agent AGENT_A --scope-config /私有目录/chat-a.json
   ```

   跨电脑时，操作者只把对应聊天的 scope 文件通过私有渠道交给该电脑；管理员配置保留在操作者处。模型凭据始终留在 harness。Node token 只管理其所属聊天。

5. 启动每台机器的连接进程。配置新增服务或 `link-tools` 后重启此进程，让新配置生效；不要同时运行两份相同 Node 配置。前台 `Ctrl+C` 正常退出，长期常驻可交给 OS 服务管理器。

   ```bash
   adl node --config /私有目录/node-mac.json
   ```

   默认只监听本机健康端口 8418，Node 向外连接 Hub。多个隔离测试 Node 可显式使用不同端口。网页显示的是聊天最近上报状态与上报时间；原生实际忙闲在投递前检查。

6. 在聊天 A 中给 agent [使用说明](docs/AGENT-GUIDE.md)，并指定它的 scope 文件。示例发送：

   ```bash
   adl context --config /私有目录/chat-a.json
   adl send --config /私有目录/chat-a.json --id msg_00000000-0000-4000-8000-000000000001 --room ROOM --to AGENT_B --text '请评审当前方案并回复'
   ```

   示例 ID 仅作格式说明；每条新消息生成新 UUID，重试同一条消息沿用原 ID。CLI 省略 `--id` 时会生成 ID，并在成功或网络失败结果中保留它。B 收到原生输入时会看到带 scope 文件路径的回复命令；模型是否使用它仍取决于当前任务及原生工具授权。普通原生文本回答不会被自动转发，需调用 `send` 明确回复。

## CLI / MCP 接入其它 harness

先用操作者分配的聊天身份登记工具收件：

```bash
adl attach --config /私有目录/node-mac.json --kind tool --session YOUR_CHAT_ID --directory /业务项目 --alias analyst
```

然后按上面的 `join / scope` 配置。运行 `adl inbox --config chat.json --after 0` 读取，`adl send ... --reply-to msg_...` 回复。`after` 是分页游标，可重复读取；不要把读取当作任务执行完成。这类身份显示 `operator-assigned`，不声称从宿主验证了真实聊天 ID。

若 harness 支持每聊天的 MCP 配置，使用：

```json
{
  "mcpServers": {
    "agent-dialogue-lite": {
      "command": "node",
      "args": ["/工具路径/agent-dialogue/packages/lite/bin/adl.mjs", "mcp", "--config", "/私有目录/chat-a.json"]
    }
  }
}
```

具体配置键因 harness 不同，以上为常见格式。四个工具的身份由配置 scope 固定，调用参数不能指定 sender。这个工具进程需要原本就有访问 Hub 的权限；Lite 不改变 harness 的沙箱或审批策略。

Kimi Code 用户希望保留 TUI 并自动收信时，按 [KIMI-TUI.md](docs/KIMI-TUI.md) 使用 `adl wait --config chat.json --after CURSOR`，让 **Kimi 原生 Bash 后台任务**运行它。普通终端中执行 `wait` 只会返回消息，不会自行唤醒模型；收到一批后需用返回 cursor 重新挂接。

## 查看跨机聊天

```bash
adl viewer --config /私有目录/operator.json --room ROOM --out /私有目录/viewer.json
```

打开 Hub 地址，如 `http://127.0.0.1:8417/`。在本机打开 `viewer.json`，把其中 `token` 填入登录框。token 只通过登录 POST 正文发送，换取 HttpOnly 同源 cookie；不要把它贴到 agent 指令或 URL。界面显示 room 成员的机器/harness/session/目录、消息正文、回复和各收件状态。只读配置可限定多个 room。

## 多机部署与升级

协议已支持远端 Hub。先在现有 VPS 安装同一包并运行 `adl hub`，每台电脑运行一个 `adl node`；本版实际跨机验收状态以验证报告为准。Node 无需公网入站端口，FRP/ZeroTier 只需提供访问 Hub 的路径。

最少配置可用 SSH 隧道：每台客户端建立 `ssh -N -L 8417:127.0.0.1:8417 your-vps`，客户端 Node/scope/viewer 的 `url` 使用 `http://127.0.0.1:8417`。本机 Viewer 也从这个地址打开。重连隧道后，Hub 中尚未开始投递的队列继续处理。

有 HTTPS 域名时，初始化 Hub 可加 `--public-origin https://hub.example`，反向代理转发到 loopback Hub。远端配置使用该 HTTPS origin。Hub 不信任任意 forwarded headers；浏览器登录的 Origin 必须匹配显式 public origin。请保持管理员配置和 SQLite 数据目录私有，Windows 放在当前用户 AppData 内。

升级先停止 Nodes 和 Hub，备份完整数据库目录（含可能存在的 SQLite WAL/SHM），再更新代码。未知 schema 会拒绝启动。Lite 不读取旧版 v0.3 的控制数据；试用旧聊天时需要在 Lite 中重新选择绑定。

遇到 `unknown`，先停止对应 Node、检查原聊天是否收到消息，保留原消息 ID。操作者确认后可记录人工核对结果：

```bash
adl resolve --config /私有目录/operator.json --id MESSAGE --agent RECIPIENT --state failed --note '已停止旧Node并核对原聊天，未收到输入' --executor-stopped
```

确认收到可改为 `--state delivered`；这两种结算均不会重发原消息，也不证明模型任务完成。`--executor-stopped` 是操作者对已停旧执行进程的明确确认，Hub 不会远程替你停止它。核对结束后重启 Node，后续队列继续。若确需重发，另用新消息 ID 并通过 `replyTo` 关联原消息。

## 开发验证

```bash
cd packages/lite
npm test
npm run test:package
```

测试包含作用域隔离、持久化、原生一次提交边界、忙闲聊天独立调度、CLI/MCP 和网页纯文本渲染。协议合同测试、真实模型测试与真实多机测试分开记录；当前记录见仓库 `verification/lite-*`。实现接口见 [INTERNAL-API.md](docs/INTERNAL-API.md)，复用来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
