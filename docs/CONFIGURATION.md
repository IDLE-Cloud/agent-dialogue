# 配置与目录

程序安装一次，工作目录、通信空间和依赖缓存分别配置。`--cwd` 指定 CLI 工作目录或过滤已有 OpenCode 会话，不自动选择通信空间。

公开仓库和 Release 下载无需 GitHub 登录。固定版本安装可使用 `npm install -g https://github.com/IDLE-Cloud/agent-dialogue/releases/download/v0.2.0/idle-cloud-agent-dialogue-0.2.0.tgz`；安装后的包名为 `@idle-cloud/agent-dialogue`，命令为 `agent-dialogue`。模型认证继续在原 harness 内完成。

## 环境变量

| 变量 | 用途与默认值 |
|---|---|
| `AGENT_DIALOGUE_SPACE` | 通信空间名称，默认 `default`；1–40 个小写字母、数字、下划线或连字符，以小写字母开头，例如 `my-project` |
| `AGENT_DIALOGUE_STATE_DIR` | 当前空间的完整目录；设置后优先于 space 名称与 XDG 默认目录 |
| `XDG_STATE_HOME` | 未显式指定状态目录时，状态基目录；默认 `~/.local/state` |
| `AGENT_DIALOGUE_CACHE_DIR` | hcom 依赖缓存基目录，优先于 XDG 缓存设置 |
| `XDG_CACHE_HOME` | 缓存基目录，默认 `~/.cache`；其下使用 `agent-dialogue` |
| `AGENT_DIALOGUE_OPENCODE_SERVICE_FILE` | 可选，明确选择本机 OpenCode 服务记录；默认 `~/.local/state/opencode/service.json` |
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

`setup` 按仓库锁定的发布包和 SHA-256 安装 hcom。切换空间不会重复下载相同平台依赖；清空缓存不应当作重置聊天的方法。默认状态不放在全局 npm 包内，升级程序不会以删除安装目录的方式同时删除消息。

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

## 停止与恢复

`detach ALIAS` 停用指定绑定、停止其 bridge 并保留原生聊天。它不停止整个 OpenCode 服务，也不影响其他未接入聊天。进程崩溃留下的 pending 或锁不自动清除；先确认输入是否已受理、是否仍有活跃 worker，再明确恢复，避免重复注入或并发占用。
