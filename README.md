# agent-dialogue

[![Tests and installation](https://github.com/IDLE-Cloud/agent-dialogue/actions/workflows/test.yml/badge.svg)](https://github.com/IDLE-Cloud/agent-dialogue/actions/workflows/test.yml)

让不同 agent 使用各自的项目聊天交流。既可以启动受管 CLI，也可以把已有 OpenCode 聊天加入项目讨论，保留原会话与上下文；不要求新建“通信专用会话”或预先定义业务角色。

当前重点是本机同一用户的协作。Codex CLI 与 OpenCode 的双向交流、OpenCode 三个已有聊天之间的项目问答及错误绑定拒收，已在 macOS arm64 原型中实测。独立版本已通过70项自动化检查、独立npm全局安装检查及macOS arm64真实依赖安装；Ubuntu Node22/24/26与macOS Node24的CI也已通过测试、全局包安装和真实依赖安装，详见兼容性说明。跨机通信、已有 Codex 桌面聊天接入和进程退出自动恢复尚未完成。

## 安装

需要 Node.js 22 或更新版本，以及准备使用的 harness；从 Git 安装还需要 Git。模型账号和权限继续由各 harness 自己管理。本包没有 npm 运行依赖，也没有自动下载或联网的 `postinstall`；hcom 通过显式 `setup` 安装。

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

也可以从仓库安装当前代码：

```bash
npm install -g git+https://github.com/IDLE-Cloud/agent-dialogue.git
agent-dialogue setup
agent-dialogue doctor
```

或从源码安装。`npm link` 使用该源码目录，因此之后应保留它：

```bash
git clone https://github.com/IDLE-Cloud/agent-dialogue.git
cd agent-dialogue
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

收到消息的 agent 会得到同一 CLI 的收发说明。它通过 shell 工具使用 `collab send --from 自己的别名 --to 对方别名` 主动发问或回复；回复使用 `--reply-to 原始数字事件ID`。可额外传 `--expected-session 完整ID` 断言接收会话。沿用原聊天的模型、上下文和工具批准策略。

room 固定成员的原生服务、session、项目目录和绑定代次；实际投递到精确 session API，不按标题或“最新聊天”猜测。界面切到其他聊天不会改变绑定。一个已有聊天可参加多个 room，这些 room 共享该聊天的模型上下文。

结束接入时：

```bash
agent-dialogue detach code-a
agent-dialogue detach code-b
```

`detach` 停止桥接，保留原生聊天和历史。历史 alias 不复用；接入新聊天时明确新建 alias 和 room。

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

消息正文保存在 hcom 账本，绑定和回执保存在当前通信空间。`collab send` 成功表示入账，worker 的 `admitted` 表示原生会话受理，实际模型回复另行核对。结果不确定时先查同一输入 ID；无法确认就暂停，不盲目重复提交。残留锁需要检查进程与所有权后明确恢复。

本机 alias 适用于同一用户的可信进程，不是多用户认证边界。不同电脑各自安装本工具，并不意味着已经互通；实时跨机消息和节点权限仍待接入，不能直接暴露 OpenCode/Codex 原生服务来代替。

更多配置见 [CONFIGURATION.md](docs/CONFIGURATION.md)，从原项目目录迁移见 [MIGRATION.md](docs/MIGRATION.md)，平台和功能边界见 [COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 开发与下一步

```bash
node --test tests/*.test.mjs
```

后续优先统一 adapter 并把 Codex 的确切已有会话接入 room，再经现有 ZeroTier 连接两机；自动启动退出进程、桌面空闲唤醒和更完整的离线恢复逐项扩展。本仓库只分发实现、测试和使用说明，不携带原研究仓库的第三方源码快照、账号数据或完整聊天记录。
