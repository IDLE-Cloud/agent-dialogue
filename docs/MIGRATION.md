# 从项目内安装迁移

当前版本入口先看[状态总览](STATUS.md)。本文件保留项目内安装到独立安装的迁移说明；2026-10-20 最新源码新增保留绑定的生命周期和显式 v1→v2 控制 store 入口，当前步骤见[生命周期指南](LIFECYCLE.md)及文末补充。统一恢复和经验证的通用升级/回退仍在[稳定化计划](V0.3-STABILIZATION-PLAN.md)中，不能把下方手工核对步骤当作已验收的通用升级工具。带日期的旧边界说明保留其历史语境。

旧版本把程序、`.runtime` 与 `.state/local` 放在研究项目目录中。独立版本将程序安装、用户状态和依赖缓存分开；不会扫描并自动接管旧目录。

迁移只影响通信工具的安装与状态，已有 Codex/OpenCode 原生聊天仍由各 harness 保存。不要复制模型密钥、OpenCode password 或原研究仓库的第三方资料快照到本仓库。

## 先保留旧通信空间

最直接的兼容方式是安装新命令，然后明确指向原有专用状态目录：

```bash
npm install -g https://github.com/IDLE-Cloud/agent-dialogue/releases/download/v0.2.0/idle-cloud-agent-dialogue-0.2.0.tgz

export AGENT_DIALOGUE_STATE_DIR=/原工具目录/.state/local
agent-dialogue setup
agent-dialogue doctor
agent-dialogue bindings
```

将示例路径替换为实际旧目录。公开仓库和 Release 可直接下载，无需 GitHub 登录；上述 URL 固定的是历史稳定 v0.2.0；无 fragment 的 `git+https://github.com/IDLE-Cloud/agent-dialogue.git` 选择 main，不能据此获得 v0.3 新能力。要使用开发版，明确选择 `#codex/multinode-adapters`，或按[状态总览](STATUS.md)固定已验证的完整提交，两端版本一致。`setup` 使用新缓存安装固定依赖，不需要搬运旧 `.runtime`。

**先停止旧 bridge，再让新程序使用相同空间。** 不能同时运行两份 worker 处理同一绑定。`detach` 可用于结束不再使用的绑定，但会将其停用，不是保留活跃绑定的无损暂停命令。若希望保留原绑定继续使用，需要先根据旧 `bridge status` 核对并正常停止确切旧 worker；不要按程序名批量终止其他进程。

原 alias、room 和 service/session 绑定仍需由新命令核验。身份或目录不一致时不自动修正。已经 detach 的历史 alias 保留，新接入使用新 alias 与新 room。旧聊天里过去收到的回复命令可能含旧程序绝对路径，后续使用新投递提供的命令，不据此假定所有旧命令已被改写。

## 再迁移到默认用户目录

如确实需要移动整个空间：

1. 记录旧状态目录和 `bindings` 输出，确认所有相关 worker 已停止，没有其他写入者。
2. 离线备份旧空间。数据库和控制文件整体保留，不在运行时只复制单个 SQLite 文件。
3. 将空间复制到新的专用目录，或在空闲状态使用可靠的 SQLite 备份方式迁移；不要合并到已有同名空间。
4. 显式将 `AGENT_DIALOGUE_STATE_DIR` 指向复制后的目录，先运行 `doctor`、`bindings` 核验。
5. 发现残留 `.lock` 或 worker 锁时先核对所有权；不要因为“是旧文件”就自动删除。确认后再逐一恢复所需 bridge。
6. 先完成一个可核对的收发，再决定是否停用旧备份。不要让两份复制状态同时作为活跃节点。

本版本没有自动数据库合并或跨机状态迁移命令。最稳妥的首次使用方式也可以是选一个新的空空间，重新 attach 同一批原生聊天；原聊天上下文会保留，但新空间不自动继承旧 room 与 hcom 消息账本。

迁移旧的 CLI `launch` 会话与迁移 OpenCode 原生 room 绑定是两种情况。旧进程的环境、hooks 和可执行文件位置可能仍指向旧安装；不要在其运行时删除旧目录或依赖。明确结束旧运行实例，再按当前入口启动或接入。

## 从v0.2升级到v0.3开发版

仍需先精确停止旧worker。v0.3按需生成当前空间的独立节点密钥，旧本机binding和room可继续用于本机协作；它们不因升级自动配对远端。要开始跨节点协作，应在交换双方卡片后创建新的共同room，再显式导出/接受清单，步骤见[NODES.md](NODES.md)。不要让旧worker与新worker同时处理同一空间，也不要在已有跨节点绑定的活跃空间中交替运行两个版本。


## 2026-10-19 当前迁移边界补充

- 安装新程序不会自动迁移原生聊天、服务描述、跨机接收路径或模型工具中的旧命令。移动程序后，核对 peer route 的接收端 Node/CLI/state/cache/service 路径，并重新生成各聊天自己的说明。ZCode 还需按 [ZCODE.md](ZCODE.md)核对 MCP command、服务描述和私有 scope；不能只更新 shell 指南。
- `hcom` 和 `embedded` 是不同账本后端，不能把同一数据库交替交给两者。Windows 原生使用 embedded；把文件从 Linux 复制到 Windows 不构成已验证迁移。新电脑通常生成独立 node，交换卡片及共同 room，而非复制另一台活动节点的私钥。
- 当前没有保留 binding 的 pause/resume。需要保留原身份时，先按确切旧 worker 所有权停止写入并完成离线备份；如果无法证明没有写入者或仍有 unknown/pending，先停留核对，不直接执行上述复制/升级步骤。`detach` 会停用旧 binding；它不是升级前无损暂停的替代。
- 旧版 `v0.2.0` 程序不能自动视为可写 v0.3 跨节点状态的回退版本。回退仅在格式兼容已验证，或使用升级前旧二进制和完整离线备份时进行；升级后新消息不能被旧备份静默覆盖。两份复制 state 不得同时运行。通用兼容矩阵及回退验收仍待 ST-06。
- 原 `m_UUID` 的传输不确定状态已有 `node flush --message m_UUID`，它不处理程序版本迁移，也不自动修复 `q_UUID`、原生 pending 或锁。保留原消息和输入证据，不清状态后换新 ID 重发。

## 2026-10-20 生命周期 schema 启用补充

最新开发源码新增 `bridge stop ALIAS` 保留 binding 停止所属 worker，以及 `bridge pause/resume ALIAS` 保留同一 binding 的通信准入。上述 2026-10-19“没有 pause/resume”描述对应当时版本；这些命令不在 `v0.2.0`、`00295d7` 或 `0aa51db` 中。完整顺序与 Windows 边界见 [LIFECYCLE.md](LIFECYCLE.md)。

程序兼容读取 v1/v2，普通 v1 行为保持 enabled；pause/resume 遇到 v1 会拒绝，不在线自动迁移。首次开启生命周期要先静止该空间全部所属 worker：当前固定安装可严格核验所属的进程使用 `bridge stop`，其他旧安装先完成原安装退出维护。随后停止所有其他 CLI/MCP/SSH 入账写入者，再私有备份整个静止空间，最后用独立固定候选安装执行：

```bash
agent-dialogue state upgrade --offline --json
agent-dialogue inspect --json
```

这里的 `bridge stop` 只适用于当前固定安装按绝对 worker 路径、binding ID 和原 token 确认所属的进程。另一个旧 prefix 中的活跃 worker，包括 POSIX worker，新候选也会标记为 unknown；旧 CLI 不具有新增的 stop 命令。必须先按已经验证的原安装退出维护流程静止这些 worker，无法证明退出就保持 needs-review。不要通过覆盖活动源码或放宽所属核验来接管它们；跨安装路径的通用迁移仍待 ST-06。

`--offline` 是操作者对所有写入者已经静止的明确声明；程序无法自动发现每个远端调用，但仍独立检查已知 live/unknown worker、退出状态、残留锁、launch reservation 与 Windows launch descriptor。遇到这些证据会拒绝，不能靠该 flag 强制通过。旧 Windows 活 worker 缺 cooperative stop 时保持待核对，不自动杀进程。现有非私有目录权限也拒绝，不能通过迁移静默修复。

成功只把控制 store 升为 v2，并为 lifecycle 建立独立 map；原 binding ID/revision、node、room、ledger backend 和 wire 身份保留。旧 writer 拒绝 v2，不能与新 writer 交替写此空间；复制 state 不得变成两个同时在线的相同 node。

pause 仍允许远端入账和本地 queue；stop 仍允许 enabled binding 的直接入口。因此二者都不单独证明可离线备份。该命令也不负责生成备份、固定发行包、更新 peer/MCP 路径或迁移 harness 原生聊天。ST-06 的完整备份清单、版本兼容矩阵、升级/允许回退验收仍待完成。

旧程序看不懂 v2 时，仅允许经验证兼容的新 state，或旧二进制配原升级前完整备份。升级后的新增消息应另保留，不得以旧备份静默覆盖；不要把 version 手改回 1，也不要自动重放差异来“补齐”。
