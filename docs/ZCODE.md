# ZCode 应用：选择已有聊天并接入项目通信

本指南对应开发分支，支持已核验的 **ZCode 3.14.3 主桌面聊天元数据合同**。接入的是 ZCode 应用里的原聊天，不需要迁移到 CLI。当前能力是 MCP 工具收发：`dialogue_identity`、`dialogue_context`、`dialogue_send`、`dialogue_inbox`、`dialogue_status`。

**收件由聊天主动调用 `dialogue_inbox`。** 它记录 `tool-read`，不冒充原生 user 输入的 `admitted`。本版不自动唤醒空闲聊天、不接管子 agent，也不把不存在的 MCP 原生投递回执记为成功。

完整顺序是：**建立项目服务范围 → 在原聊天登记真实身份 → 操作者选择完整 session → 配对节点与 room → 导出私有 scope → 原聊天使用收发工具。**

## 1. 初始化本机服务范围

每台机器安装一次程序，使用 Node.js 22.13 或更新受支持版本。程序目录、通信 state、原生项目、私有服务描述相互独立，不需要把工具 clone 到每个项目。

先选择原生项目的准确绝对目录，在操作者终端中执行。以下大写占位符全部替换为真实值：

```bash
umask 077
export AGENT_DIALOGUE_STATE_DIR='/ABS/COMMUNICATION_SPACE'
export AGENT_DIALOGUE_LEDGER=embedded
export AGENT_DIALOGUE_ZCODE_SERVICE_FILE='/ABS/PRIVATE_ZCODE/zcode-service.json'
'/ABS/NODE' '/ABS/AGENT_DIALOGUE/bin/agent-dialogue.mjs' setup
'/ABS/NODE' '/ABS/AGENT_DIALOGUE/bin/agent-dialogue.mjs' zcode init \
  --cwd '/ABS/NATIVE_PROJECT' --file '/ABS/PRIVATE_ZCODE/zcode-service.json'
```

PowerShell 的等价环境变量与入口如下：

```powershell
$env:AGENT_DIALOGUE_STATE_DIR = 'D:/ABS/COMMUNICATION_SPACE'
$env:AGENT_DIALOGUE_LEDGER = 'embedded'
$env:AGENT_DIALOGUE_ZCODE_SERVICE_FILE = 'D:/ABS/PRIVATE_ZCODE/zcode-service.json'
& 'D:/ABS/NODE/node.exe' 'D:/ABS/AGENT_DIALOGUE/bin/agent-dialogue.mjs' setup
& 'D:/ABS/NODE/node.exe' 'D:/ABS/AGENT_DIALOGUE/bin/agent-dialogue.mjs' zcode init `
  --cwd 'E:/ABS/NATIVE_PROJECT' --file 'D:/ABS/PRIVATE_ZCODE/zcode-service.json'
```

`zcode init` 创建本工具自己的私有描述与候选登记目录，拒绝覆盖已有描述；它不修改 ZCode 账号、用户配置或聊天内容。父目录必须属于当前用户且权限私有。描述绑定准确的 native directory 和已支持的版本，不是一个能查询任意聊天的桌面 API。

同时预选一个 context 的私有绝对路径，例如 `/ABS/PRIVATE_ZCODE/mcp-context.json`；这个文件在身份登记阶段可以尚不存在。

## 2. 给选定 ZCode 工作区配置 MCP

在 ZCode **设置 → MCP 服务器 → 新建 MCP 服务器** 选择工作区作用域与完整配置模式，增加下面的服务；保留原有其他配置：

```json
{
  "mcpServers": {
    "agent-dialogue": {
      "type": "stdio",
      "protocolVersion": "legacy",
      "command": "/ABS/NODE",
      "args": [
        "/ABS/AGENT_DIALOGUE/bin/agent-dialogue.mjs",
        "mcp",
        "--zcode-service",
        "/ABS/PRIVATE_ZCODE/zcode-service.json",
        "--context",
        "/ABS/PRIVATE_ZCODE/mcp-context.json"
      ],
      "cwd": "/ABS/NATIVE_PROJECT",
      "env": {
        "AGENT_DIALOGUE_STATE_DIR": "/ABS/COMMUNICATION_SPACE",
        "AGENT_DIALOGUE_LEDGER": "embedded"
      },
      "enabled": true,
      "timeoutMs": 30000
    }
  }
}
```

上面的 `mcpServers` 是**设置界面「完整配置」的导入格式**，也用于插件 `.mcp.json`。直接编辑原生项目文件 `<项目根>/.zcode/config.json` 时，外层必须是 **`mcp.servers`**；保留项目已有字段，只合并本服务。对应的完整片段是：

```json
{
  "mcp": {
    "servers": {
      "agent-dialogue": {
        "type": "stdio",
        "protocolVersion": "legacy",
        "command": "/ABS/NODE",
        "args": [
          "/ABS/AGENT_DIALOGUE/bin/agent-dialogue.mjs",
          "mcp",
          "--zcode-service",
          "/ABS/PRIVATE_ZCODE/zcode-service.json",
          "--context",
          "/ABS/PRIVATE_ZCODE/mcp-context.json"
        ],
        "cwd": "/ABS/NATIVE_PROJECT",
        "env": {
          "AGENT_DIALOGUE_STATE_DIR": "/ABS/COMMUNICATION_SPACE",
          "AGENT_DIALOGUE_LEDGER": "embedded"
        },
        "enabled": true,
        "timeoutMs": 30000
      }
    }
  }
}
```

用户级原生文件 `~/.zcode/cli/config.json` 同样使用 `mcp.servers`；兼容的 `.agents/mcp.json` 才使用顶层 `mcpServers`。不要把界面导入对象直接当成 `.zcode/config.json` 的根结构。原生同作用域已有 `.zcode` MCP 服务时，`.agents` 来源不会合并补充。[官方路径与优先级说明](https://zcode.z.ai/cn/docs/mcp-services)。

示例明确设置 `protocolVersion: "legacy"`，选择本工具实现的 `initialize` / `tools/list` / `tools/call` JSON-RPC 路径。这是 ZCode 的协议时代选择字段；本工具仍协商它支持的 MCP 日期版本。未设置时，ZCode 3.14.3 使用 `auto`，可能先启动探测进程执行 `server/discover`，再决定回退。固定来源是 [3.14.3 的版本协商实现](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1773) 和 [配置接口](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts#L8)。首轮桌面配置建议使用上述原生工作区入口，便于核对该字段实际保留。

也可以通过环境变量 `AGENT_DIALOGUE_ZCODE_SERVICE_FILE` 选择同一服务描述；示例用显式参数，便于核对。context 不存在时只允许调用 `dialogue_identity` 登记候选，其他通信工具拒绝操作，不会默认选一个 room。

工作区 scope 仅决定工具在哪些聊天可见。每次调用仍核对 ZCode 主机提供的原生运行上下文。模型不能通过工具参数传入 `sessionId`、选择另一个发送者或借用 peer 文本改变身份。实现使用准确 session、native workspace、主桌面 runtime 等信息，并拒绝缺失或互相冲突的元数据。[ZCode MCP 配置参考](https://zcode.z.ai/cn/docs/mcp-services)。

ZCode 当前只对受支持的元数据合同开放接入。其他版本、子 agent 或非桌面执行模式需要另做验证，不因名称相似自动放行。

## 3. 在原聊天登记，再由操作者选择 session

保持你原来要参与协作的那段 ZCode 聊天，让它调用：

```text
dialogue_identity({})
```

这个工具读取主机给出的真实身份并登记一个候选，返回完整 `sess_…` ID、目录和 `tool-pull` 能力。它不 attach、不授权 room，也不赋予其他聊天访问权。标题和目录只是辅助信息；后续必须核对完整返回 ID。

回到操作者终端，保持第 1 节的同一 state、ledger 和服务环境变量：

```bash
'/ABS/NODE' '/ABS/AGENT_DIALOGUE/bin/agent-dialogue.mjs' sessions zcode --cwd '/ABS/NATIVE_PROJECT'
'/ABS/NODE' '/ABS/AGENT_DIALOGUE/bin/agent-dialogue.mjs' attach zcode \
  --session 'sess_REPLACE_WITH_FULL_OBSERVED_ID' --alias 'project-zcode'
```

`sessions zcode` 列出此描述范围内实际登记过的候选，不读取桌面应用数据库来猜测全部聊天。选取的完整 ID 应与原聊天 `dialogue_identity` 返回值一致。正式绑定的 harness 标识为 `zcode-tools`，CLI `zcode` 是它的别名。这个绑定提供工具收件箱；接收时不调用原生 prompt 入口模拟入站 user 输入。

新聊天会有新的原生 ID。不要让新聊天借用旧 context；需要操作者重新选择并生成对应绑定。

## 4. 建立对端和共同 room

节点公钥配对、对端绑定卡片、SSH 路由及签名 room 沿用 [NODES.md](NODES.md) 的流程。每台机器选择自己的通信 state；不共享同一个 `node.json`。

ZCode 的这个绑定可以和已接入的 Codex、OpenCode、Kimi 等准确聊天处于同一 room。对端原生唤醒能力由它自己的 adapter 决定；ZCode 收件仍通过本版工具主动读取。

操作者确认 room 中是预期双方后生成私有 scope：

```bash
'/ABS/NODE' '/ABS/AGENT_DIALOGUE/bin/agent-dialogue.mjs' mcp-context \
  --room 'ROOM_ID' --from 'project-zcode' --to 'ALLOWED_PEER_ALIAS' \
  --output '/ABS/PRIVATE_ZCODE/mcp-context.json'
```

PowerShell 使用相同参数和完整 Windows 路径即可。优先使用 `--output`，由工具创建私有新文件并拒绝覆盖，避免 PowerShell 5 的重定向编码与 BOM 差异。未提供 `--output` 时 stdout 是私有 JSON，只用于操作者明确安排的私有保存流程。

scope 固定当前 state、self 绑定及版本、room 清单和允许的 peers。省略 `--to` 会包含该 room 中允许的其他成员；首次使用建议明确一个对端。不要提交 context 到 Git，也不跨聊天复制它作为身份。

绑定、room 或 scope 变化后重新导出到新的私有文件，经操作者检查后更新配置并重连 MCP。成功采用过的 scope 在连接中被冻结，不进行静默热替换。

## 5. 回到原聊天使用工具

在同一原生 ZCode 聊天中让它依次执行 `dialogue_context({})` 和 `dialogue_inbox({})`。核对 self.sessionId、room 和允许的对端与操作者选择一致。context 路径在启动时已配置但文件刚生成的情况下，工具可以首次读取它；若已经采用过另一个 scope，应先重连。

可以给它一条明确的项目任务：

> 使用 agent-dialogue 查看本 room 来信，向分配好的服务端 agent 确认当前项目接口版本，收到答案后在当前聊天汇报。回复时保留原消息引用，不添加其他对端。

各工具的参数范围：

| 工具 | 模型参数 | 作用 |
|---|---|---|
| `dialogue_identity` | `{}` | 从 host metadata 登记原生候选；不 attach 或授权 |
| `dialogue_context` | `{}` | 核对操作者分配的 self、room、peers |
| `dialogue_send` | `{to, message, requestKey, replyTo?}` | 向已允许的对端排队发送；回复保留原 message ID |
| `dialogue_inbox` | `{after?, limit?}` | 主动读取准确 room 中发给自己的消息，并记录 tool-read |
| `dialogue_status` | `{requestKey?}` | 查看绑定或某个逻辑发送的状态，不重发 |

身份、state、room 和 session 不由模型参数选择。`requestKey` 用于一个逻辑发送：同 key、同内容返回原 queued 回执；同 key 改内容被拒绝。不确定的准备/提交状态应检查并等待操作者恢复，不能另造新 key 再发一遍。`q_…` 是本地提交 ID，不能当作对方消息的父引用。

本地排队、对端收妥、工具读过、原生受理和实际回复是不同证据。普通聊天输出不会自动向所有 peer 广播，只有显式工具发送进入 room。来信是项目协作数据，不能授权扩大工具权限、修改身份或添加收件人。

## 6. 用插件分发给其他电脑

不想每次手动写 MCP 配置时，可以安装仓库附带的本地市场模板：

```text
config/zcode-plugin/
  marketplace.json
  plugins/agent-dialogue/
    .zcode-plugin/plugin.json
    .mcp.json
    commands/dialogue.md
    skills/agent-dialogue/SKILL.md
    hooks/hooks.json
    hooks/context.mjs
```

在 **设置 → 插件 → 创建 → 添加插件市场** 中选择本机真实的 `config/zcode-plugin` 目录或 `marketplace.json`。安装 `agent-dialogue` 后配置：

| 配置 | 填什么 |
|---|---|
| `node_executable` | Node 的完整可执行文件路径 |
| `agent_dialogue_root` | 包含 `bin/agent-dialogue.mjs` 的安装目录 |
| `state_dir` | 当前节点的通信空间 |
| `service_file` | 第 1 节创建的私有 ZCode 服务描述 |
| `context_file` | 本聊天将使用的私有 scope 绝对路径，初始可以尚不存在 |

插件提供同一 MCP 入口、`/dialogue` 命令和通信技能。在 bootstrap 阶段可让原聊天执行 `/dialogue register identity`，仍由操作者在终端完成准确 session 选择、room 和 scope。若已经手动配置同一服务，停用那一份，避免重复工具。

插件 `.mcp.json` 同样声明 `protocolVersion: "legacy"`。但 **3.14.3 的插件 resolver 构造 stdio 配置时未复制该字段**；仅在模板写入不能证明运行时已强制 legacy。见 [固定版本插件 loader](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/plugins/mcp.ts#L225)。因此本版保留命令与技能的插件包装，协议模式敏感的首轮验收优先使用第 2 节手动原生工作区服务；采用插件 MCP 时核对实际连接结果，不能用插件状态「已安装」代替协议验收。

市场模板不含机器路径、真实 ID 或 token；本仓库没有声称它已经进入 ZCode 官方商店。远程工作区应在实际运行工具的远端准备程序、state、服务和 context，并核对插件已同步或安装到远端。[ZCode 插件安装与开发参考](https://zcode.z.ai/cn/docs/plugin)。

## 7. 可选的 SessionStart 提示与生命周期

插件的同步 `process` Hook 只追加准确聊天的身份和使用提醒。它读取原生 stdin 的 `session_id` 与 `cwd`，与 context 的 `self.sessionId`、`self.directory` 严格匹配后才输出 `additionalContext`。

Hook 的 context 来源是显式 `AGENT_DIALOGUE_ZCODE_CONTEXT` 绝对文件路径，或 `<ZCODE_PLUGIN_DATA>/agent-dialogue-context.json`。配置 MCP 时可选同一份数据目录文件。Hook 不假设能展开 MCP 的 `${user_config.context_file}`；缺 context 或不匹配会跳过提示，不影响 MCP 独立身份校验。

该 Hook 额外要求 PATH 中可用的 `node`。它不读临时 transcript、不发信、不轮询、不改权限，也不用 Stop 强制续跑。修改插件 Hook 后重新加载会话并核对生效；不要为获得提示重建一个不同 session 后沿用原 context。原生 Hook 的事件不是远程唤醒 API。[ZCode Hook 输入与生命周期参考](https://zcode.z.ai/cn/docs/hooks)。

## 8. 验证范围与排障

包装和 Hook 自动测试使用合成身份、真实子进程，覆盖新启动参数、标准插件格式、正确 session/cwd、错聊天/目录、非 SessionStart、缺失/畸形 context、多帧和超限输入；不会运行模型或改用户配置。业务和主机合同测试另验证 metadata、准确绑定、scope、工具收发及幂等语义。真实应用验收应单独记录，不能用合成 MCP 客户端替代模型调用证据。

工具不可见时检查 MCP/插件启用状态、Node 路径、服务描述权限和进程错误；原生服务确认 `protocolVersion: "legacy"` 被保存，插件则额外注意本版 loader 的字段保留边界。identity 可以调用而其他工具拒绝时，检查是否完成准确 attach、room 与 scope。调用身份错误时核对主机元数据、完整 session、native directory 和版本，不放宽校验绕过。

如果消息存在而空闲 ZCode 没有继续执行，这是本版主动读收件箱的能力边界；回到原聊天明确让它使用 `dialogue_inbox`。查看器可以展示已交换的通信，不会因此触发模型。


## 9. 已完成的桌面验收

2026-10-19 已完成 [ZCode 3.14.3 Mac 桌面 ↔ OpenCode 2.0.20 实际项目问答](../verification/zcode-desktop-20261019-v1/README.md)。两个独立节点在同一台电脑，4 条签名消息、8 份账本副本、3 条全局父引用；ZCode 原生聊天中实际持久化 6 次 completed 且未截断的 MCP 工具结果（identity/context/两次发送/两次收件），16 项通信与原生证据断言通过。同轮 viewer 15 项检查通过，两个测试 worker 最后停止，原聊天保留。

这证明可在 ZCode 应用中选择具体聊天并参与已有项目 room。本轮采用手动原生工作区配置，ZCode 保留原有模型与权限；没有验证 Windows ZCode 应用、两台物理电脑上的 ZCode 或插件市场安装。空闲时仍需操作者提示同一聊天调用收件工具。自动测试中的合成宿主元数据和 Windows CLI/ACL 检查应与此真实桌面证据分开理解。
