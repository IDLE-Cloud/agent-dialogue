# VPS 部署前置指南

本文准备一台运行 OpenCode 的 Linux VPS，与另一台电脑上的 Codex/OpenCode 项目聊天协作。它是部署模板；实际双机通过情况以对应验收结果为准。配对命令见 [NODES.md](NODES.md)，受控实机测试见 [VPS-ACCEPTANCE.md](VPS-ACCEPTANCE.md)，不需要重复部署一套中心消息服务。

## 1. 独立账号、版本和目录

由管理员准备专用普通账号；以下安装、服务、模型配置和通信进程都在该账号内运行。该账号只保存参与项目需要的文件，不复用管理员的模型认证或私钥。每台电脑保留自己的原生聊天和 node 私钥；安装包可以相同，state 不跨机共享。

两端需要 Node.js **22.13 或更新的受支持版本**、npm、Git 和可用的 SSH 客户端；VPS 还需要已配置的 SSH 接收入口。先核对实际程序路径：

```sh
node --version
node -p process.execPath
npm --version
```

VPS 安装本项目当前适配的 **OpenCode V2 2.0.20**。它的 npm 包是 `@opencode/cli`；V1 的服务/API 契约不同，不能只看到一个叫 `opencode` 的命令就认为版本合适。[OpenCode V2 官方安装说明](https://opencode.ai/v2/docs/)列出了这个包；升级其他版本前重新核对兼容性。

```sh
npm install -g --prefix "$HOME/.local" @opencode/cli@2.0.20
DIALOGUE_NODE_BIN_DIR="$(dirname "$(node -p process.execPath)")"
export PATH="$HOME/.local/bin:$DIALOGUE_NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin"
"$HOME/.local/bin/opencode" --version
"$HOME/.local/bin/opencode" service --help
```

两端安装同一个已核对的 agent-dialogue 提交。把下面的 `COMMIT_SHA` 替换为实际提交；v0.3 功能尚在开发分支，旧稳定版 v0.2.0 不包含完整跨节点功能。

```sh
npm install -g --prefix "$HOME/.local" \
  'git+https://github.com/IDLE-Cloud/agent-dialogue.git#COMMIT_SHA'

export AGENT_DIALOGUE_STATE_DIR="$HOME/projects/example/.agent-dialogue"
export AGENT_DIALOGUE_CACHE_DIR="$HOME/.cache/agent-dialogue"
mkdir -p "$AGENT_DIALOGUE_STATE_DIR"
chmod 700 "$AGENT_DIALOGUE_STATE_DIR"
agent-dialogue setup
agent-dialogue doctor
```

`setup` 安装仓库锁定版本和校验值的 hcom；`doctor` 检查本机依赖，不证明模型登录、免费额度或具体聊天可用。实际配置应记录 Node、JavaScript CLI、state、cache 的绝对路径，SSH 不依赖交互终端中的 shell 初始化脚本。Codex 端的 state 必须位于原 thread 已允许写入的项目目录内。状态目录及生成的个人通信指南加入项目忽略规则。

## 2. 启动 VPS 上的本地 OpenCode 服务

在这个专用账号内使用已核对的 V2 可执行文件：

```sh
"$HOME/.local/bin/opencode" service set hostname 127.0.0.1
"$HOME/.local/bin/opencode" service set env PATH "$PATH"
"$HOME/.local/bin/opencode" service start
"$HOME/.local/bin/opencode" service status
```

服务和模型执行使用的 PATH 都应包含该账号的 Node、hcom 所需系统工具，以及本轮明确选择的私有 SSH wrapper（若有）。仅修改登录终端的 PATH，不会自动更新一个已经运行的服务。修改 service 设置会停止原服务，应在专用服务内明确重新启动。[V2 服务与环境命令](https://opencode.ai/v2/docs/cli/commands/#service)和[loopback 服务说明](https://opencode.ai/v2/docs/cli/web/)可用于核对当前 CLI 行为。

agent-dialogue 通过本机服务记录选择准确服务，默认是 `~/.local/state/opencode/service.json`；非默认位置设置 `AGENT_DIALOGUE_OPENCODE_SERVICE_FILE`。保留服务记录的私有权限，让当地 adapter 自行读取密码，不把密码放进 SSH 参数、节点卡片或项目仓库。无需向公网开放 OpenCode HTTP 端口，也无需把控制端的模型凭据复制到 VPS。

在实际项目目录准备或选择模型。V2 模型目录具有 location 范围；API 应使用 URL 编码的 `location[directory]` 指定完整项目目录。服务刚启动时模型快照可能尚未完成初始化，应有限等待并核对所选 model 是否启用，不能把第一次空列表解释为安装失败。[官方模型目录 API](https://opencode.ai/v2/docs/api#model)说明了 location 和快照语义。免费验收须同时检查全部价格层的 input、output、cache read、cache write 都是数值零；没有合适模型时停止，不自动换成收费模型。

## 3. 双向 SSH 与本机在 NAT 后的情况

先由操作者核对并登记主机密钥，准备 **控制端 → VPS** 与 **VPS → 控制端** 两个准确路由。ZeroTier 可以直接提供可达性；SSH alias、账号、密钥、端口和接收端路径分别固定在私有配置中。保持 `BatchMode=yes` 和主机密钥校验，不以接受未知密钥作为自动恢复。

如果控制端不能被 VPS 直接访问，可以由控制端建立单独的 reverse tunnel。下面只有占位 alias 和端口，需替换为事先配置好的入口：

```sh
ssh -N -T \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -R 127.0.0.1:22222:127.0.0.1:22 VPS_ALIAS
```

VPS 上把反向路由配置为连接 `127.0.0.1:22222`，使用控制端接收账号及该接收入口的已核对 host key。本机的 `22` 可以换成操作者已经配置的专用 SSH 接收入口；agent-dialogue 本身不提供 SSH 服务器。隧道监听保持 VPS loopback。隧道是独立运行资源，需要由操作者或明确配置的进程管理器维护；关闭 viewer 不会维护或重建隧道。

反向接收密钥可以使用 `authorized_keys` 的固定命令，只允许本轮选定的 `node receive`。receiver 应核对完整预期请求命令，然后直接执行固定 Node/CLI/state/cache/Codex 路径；**不执行或 eval 任意 `SSH_ORIGINAL_COMMAND`**。正文与签名只走 stdin。receiver 的 exec 环境也必须明确选择当地 Codex socket/数据目录或 OpenCode 服务文件。用于建立转发的密钥与只收消息的密钥可以分别限制；固定 receiver 无需提供通用控制端 shell。

运行时 SSH `node receive`、只读 `view-export` 和开发验收 helper 是不同用途。仅允许接收消息的密钥不能直接承担查看或部署操作；所需命令应分别由操作者配置。本工具不修改全局 SSH 配置，也不会扩展既有聊天的权限。

## 4. 接入准确的已有聊天，再开始协作

在每台电脑上，用相同 state 环境运行：

```sh
agent-dialogue sessions opencode --cwd /absolute/project
agent-dialogue attach opencode --session ses_EXACT_EXISTING_ID --alias vps-agent
agent-dialogue bindings
```

Codex 端使用 `sessions codex` 和完整 thread UUID；只有明确选择后才用 `attach codex --resume` 加载同一个未加载的 thread。核对服务身份、目录、session、binding revision，避免按标题或“最新聊天”寻址。两个 agent 使用不同 alias。随后按 [NODES.md](NODES.md) 双向交换签名卡片、固定接收端路径，并由双方接受同一个 sealed room。

每台机器为自己的聊天重新生成 `agent-guide --room … --from … --to …`，在该原生聊天中明确要求读取。保留指南给出的环境前缀和 `--expected-session`；跨机回复使用收到的全局 `m_…` ID。Codex 可通过 `--queue` 写入本地请求，由自己的 worker 执行 SSH；`queued`、`remote-stored`、原生受理和真实回复分别核对。详见[使用指南](USAGE.md)。

## 5. 查看与验收

控制端运行 `agent-dialogue view --config /absolute/private/viewer.json`，显式指定允许观察的远端 host、Node/CLI/state、预期 node ID 和 room 的 ID/revision/manifest hash。配置格式见 [VIEWER.md](VIEWER.md)。页面仍在控制端 loopback，无需公开 VPS 或 viewer 端口；采集失败保留的旧快照不能证明对方当前在线。room scope 是采集约束，SSH 账号的操作系统权限仍需单独配置。

要运行开发验收，另选一个由自己拥有的 Codex 测试 thread 和两边全新的 state，并按 [VPS-ACCEPTANCE.md](VPS-ACCEPTANCE.md) 准备私有配置、单文件 helper 和全新结果目录。该 runner 会创建自己的 VPS 测试聊天，不会自动接管用户项目聊天；日常已有聊天的 `attach` 则不要求新建。失败记录与聊天保留，下一轮使用新 run ID 和 state。对某次实机测试的成功、失败和清理结果，应引用该次实际指标，不能由安装成功或合成测试推断。

## 独立 Codex 验证进程的网络

桌面 Codex 正常工作，并不保证另外启动的 `codex app-server` 具有相同网络环境。若当前电脑原本使用 HTTP/HTTPS 代理，应先核对那个已有代理，再仅为专用验证进程显式设置 `HTTP_PROXY`、`HTTPS_PROXY`，并让 `NO_PROXY` 包含 `127.0.0.1,localhost,::1`，保持原生 loopback API 和 socket 在本机。不要为了处理模型连接超时改聊天的模型、审批或 sandbox。原生模型采样、消息队列受理和跨机 SSH 投递需要分别诊断。
