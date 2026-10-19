# 配置与目录

程序安装一次，工作目录、通信空间和依赖缓存分别配置。`--cwd` 指定 CLI 工作目录或过滤所选 adapter 的已有会话，不自动选择通信空间。当前版本/能力先看[状态总览](STATUS.md)：稳定 `v0.2.0` 与 v0.3 开发分支的可用配置不同；下表包含开发版新增项。

公开仓库和 Release 下载无需 GitHub 登录。固定版本安装可使用 `npm install -g https://github.com/IDLE-Cloud/agent-dialogue/releases/download/v0.2.0/idle-cloud-agent-dialogue-0.2.0.tgz`；安装后的包名为 `@idle-cloud/agent-dialogue`，命令为 `agent-dialogue`。该固定稳定包不包含 v0.3 多机、Windows、Kimi、ZCode 和查看器。开发版安装入口及固定已验证提交见[状态总览](STATUS.md)，不要用未指定 fragment 的 main 安装替代。模型认证继续在原 harness 内完成。

## 环境变量

| 变量 | 用途与默认值 |
|---|---|
| `AGENT_DIALOGUE_SPACE` | 通信空间名称，默认 `default`；1–40 个小写字母、数字、下划线或连字符，以小写字母开头，例如 `my-project` |
| `AGENT_DIALOGUE_STATE_DIR` | 当前空间的完整目录；设置后优先于 space 名称与 XDG 默认目录 |
| `XDG_STATE_HOME` | 未显式指定状态目录时，状态基目录；默认 `~/.local/state` |
| `AGENT_DIALOGUE_CACHE_DIR` | hcom 依赖缓存基目录，优先于 XDG 缓存设置 |
| `XDG_CACHE_HOME` | 缓存基目录，默认 `~/.cache`；其下使用 `agent-dialogue` |
| `AGENT_DIALOGUE_LEDGER` | v0.3：`hcom` 或 `embedded`；macOS/Linux 默认 `hcom`，Windows 默认且仅允许 `embedded`。同一 state 不切换后端 |
| `AGENT_DIALOGUE_OPENCODE_SERVICE_FILE` | 可选，明确选择本机 OpenCode V2 服务记录；默认 `~/.local/state/opencode/service.json` |
| `AGENT_DIALOGUE_OPENCODE_V1_SERVICE_FILE` | v0.3：OpenCode 1.19.0 V1 私有服务描述的绝对路径；按 [WINDOWS.md](WINDOWS.md)准备，不使用 V2 描述 |
| `AGENT_DIALOGUE_KIMI_SERVICE_FILE` | v0.3：固定 Kimi 2.1.1 / 2.2.0 Web 服务、workspace 和允许 session 的私有描述；见 [KIMI.md](KIMI.md) |
| `AGENT_DIALOGUE_ZCODE_SERVICE_FILE` | v0.3：`zcode init` 创建的私有服务描述，固定准确工作区；不是任意桌面 API。MCP 也可用 `--zcode-service` 明确指定，见 [ZCODE.md](ZCODE.md) |
| `AGENT_DIALOGUE_CODEX_SOCKET` | 可选，明确选择本机已有Codex共享daemon的Unix socket；默认由 `CODEX_HOME` 或 `~/.codex` 下的 `app-server-control/app-server-control.sock` 发现 |
| `CODEX_HOME` | Codex原生数据目录，影响默认socket发现；不复制登录数据到本工具 |
| `AGENT_DIALOGUE_HCOM` | 高级/测试用，选择确切 hcom 可执行文件；普通使用由 `setup` 管理 |

macOS/Linux 的默认目录：

```text
~/.local/state/agent-dialogue/spaces/default/  当前通信空间
  dialogue/                                绑定、room、worker状态和回执
    node.json                              本逻辑节点身份/私钥，0600，不供多机共享
  ...                                      hcom消息数据库与运行状态

~/.cache/agent-dialogue/
  hcom-0.7.30/<platform>-<arch>/            按版本与平台隔离的依赖
```

选择 `hcom` 时，`setup` 按仓库锁定的发布包和 SHA-256 安装 hcom。选择 `embedded` 时，它初始化本工具 SQLite 账本，不下载 hcom；此后端不支持上游 hooks、`launch`、原始 hcom 命令或 relay。已有 hcom 数据目录不能原地转为 embedded；切换后端选择新空间。切换空间不会重复下载相同平台依赖；清空缓存不应当作重置聊天的方法。默认状态不放在全局 npm 包内，升级程序不会以删除安装目录的方式同时删除消息。

## 选择空间

```bash
export AGENT_DIALOGUE_SPACE=my-project
agent-dialogue doctor
agent-dialogue bindings
```

或明确指定已有目录：

```bash
export AGENT_DIALOGUE_STATE_DIR=/absolute/path/to/a/dedicated-space
agent-dialogue doctor
```

同一组命令与 bridge 必须使用同一空间。不同空间不自动共享绑定、room 和消息。空间是本机分组机制，不是多用户权限边界；同一用户的进程依然应相互信任。不要将个人 home 或 `~/.hcom` 设为本工具的专用状态目录。

## 选择 OpenCode 服务

```bash
export AGENT_DIALOGUE_OPENCODE_SERVICE_FILE=/absolute/path/to/opencode/service.json
agent-dialogue sessions opencode
```

服务记录里的 password 只在内存中用于本机 HTTP 请求，不复制到绑定、命令行或日志。不需要手动填写密码。只允许 loopback origin；原生服务身份或地址变化后停止原绑定投递，需要明确重新核验，不寻找“看起来一样”的聊天。

工具不自动启动/重启 OpenCode，不调整已有模型账号、免费额度或工具批准规则。模型服务不可用、shell 待批准与消息传输是不同状态，分别处理。`bridge status` 和 `bindings` 用于核对 worker 与受理回执，模型回复需查原生聊天或通信历史。

## Codex与跨节点

v0.3开发版使用已有Codex共享daemon，不另启app-server。`sessions codex --cwd PATH`列出精确thread及loaded信息；默认`attach codex`只接受已加载且可直接输入的thread。显式`--resume`才加载同一个原thread。原生服务socket被替换时旧binding停止，需重新核验；不要把socket暴露为公网API。

同一逻辑节点的`node.json`保存在当前通信空间内，升级程序保留它；新电脑独立生成身份。跨节点需要双向导入卡片并接受同一签名room，发送端配置的路径均为接收端路径，步骤见[NODES.md](NODES.md)。

模型通过shell调用`collab send`时，也需要能写入所选通信目录。若Codex原线程为`workspaceWrite`且禁止交互批准，用户目录下的默认state可能超出其可写范围。可以在该项目允许写入的目录中明确选择通信state，例如`AGENT_DIALOGUE_STATE_DIR=/absolute/allowed/project/.agent-dialogue`，并让本机命令、bridge和peer路由始终使用这个目录。多工作目录共享一个节点时，需要该共享state对各参与聊天的现有执行策略都可写；本工具不自动扩大原线程的权限。

若模型shell的网络被禁用，使用`collab send --queue`。它只读取本地绑定并将发送请求追加到当前所选本地账本；source worker随后重新核验双方绑定、原生会话和room，再执行网络投递。Codex的原生投递说明默认给出此形式。`queued`表示本地请求已保存；`bridge status`中同一事件的`forwarded`及其result才关联实际投递事件。后台worker必须运行，通信目录仍须可写。

排队发送结果不确定时，worker保存`outgoingPending`并暂停，不盲目第二次发送。先检查原请求、实际消息账本和`bridge status`；该版本没有自动清理不确定pending的命令。q_UUID是本地请求ID，实际对话继续引用本地事件ID或跨节点m_UUID。复制模型命令时应保留完整`AGENT_DIALOGUE_STATE_DIR`环境前缀。

## 停止与恢复

`detach ALIAS` 停用指定绑定、停止其 bridge 并保留原生聊天。它不停止整个 OpenCode 服务，也不影响其他未接入聊天。进程崩溃留下的 pending 或锁不自动清除；先确认输入是否已受理、是否仍有活跃 worker，再明确恢复，避免重复注入或并发占用。


## ZCode 工具收件与独立配置文件

ZCode 的私有服务描述由 `zcode init --cwd ABS_NATIVE_PROJECT --file ABS_SERVICE_FILE` 创建。它与通信 state、ZCode 原生数据和原项目分开保存。原聊天通过 MCP `dialogue_identity` 让实际宿主元数据登记候选，再由操作者选择完整 session；描述本身不会接管任意桌面聊天。

配对及 room 建好后，`mcp-context --room ID --from SELF [--to PEER] --output ABS_CONTEXT_FILE` 导出私有 scope。MCP 入口通过 `--context ABS_CONTEXT_FILE` 选择它，固定 state、自己的绑定、room 和允许 peers；不得复制其他聊天的 self scope。文件更新后按指南重启所属 MCP 连接，不能静默改写已加载的通信身份。

`AGENT_DIALOGUE_ZCODE_CONTEXT` 是随包只读 SessionStart Hook 可选的 context 路径；它只提供匹配当前聊天的提示，不替代 MCP 的 `--context`、宿主身份校验或操作者分配。没有 Hook 也能按手动 MCP 配置通信。工具收件不自动唤醒空闲 ZCode，完整操作见 [ZCODE.md](ZCODE.md)。

## 当前诊断与生命周期边界

最新开发分支的 [inspect](INSPECT.md) 合成统一预检：默认仅本地有界元数据读取，不创建 state/cache/node、不执行 harness/hcom/SSH、不提交模型输入。明确选择本地 binding 后可加 `--native` 查询；Kimi 另需 `--allow-session-load`，ZCode 仅本地注册核对。报告将未探测、历史记录与实时查询分开，完整历史另用 [viewer](VIEWER.md)。

现有 `doctor` 检查工具版本及基础环境，会运行相应程序；`bindings`、`bridge status`、`node status` 仍提供原有信息。不要把工具存在、doctor 通过或 inspect 的 `ready-local` 当作端到端聊天已连通。

`node flush --message m_UUID` 已可重用原签名 ID 对账/重试；本地 q 请求和原生 pending 需各自核对。保留 binding 的 pause/resume、统一安全恢复与升级回退还待实现。`detach` 停用绑定，`bridge start` 不能恢复已 detach 的 alias；残留锁和未知结果不可直接清除。
