# 从项目内安装迁移

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

将示例路径替换为实际旧目录。公开仓库和 Release 可直接下载，无需 GitHub 登录；若要使用仓库当前代码，也可运行 `npm install -g git+https://github.com/IDLE-Cloud/agent-dialogue.git`。`setup` 使用新缓存安装固定依赖，不需要搬运旧 `.runtime`。

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
