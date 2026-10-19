# 统一预检使用说明

`inspect` 是 v0.3 开发分支新增入口，历史稳定包 v0.2.0 和先前固定开发基线不含此命令。安装版本的选择见 [STATUS.md](STATUS.md)；它不替代接入时的准确聊天选择。

## 1. 安装后、setup 前就能检查

```bash
agent-dialogue inspect --json
```

命令读取当前 `AGENT_DIALOGUE_STATE_DIR` / space 对应的已有信息；不存在时返回 `unconfigured`，保持 state、cache、node 和账本不存在。可在任何项目目录运行。它不会执行 harness 的 `--version`、hcom 或 SSH，不会重启服务、启动 worker 或调用模型。

默认检查包含程序版本、所选路径、账本文件头、已有节点身份和权限、binding/room pins、worker 记录、锁和待核对标记。它不打开 SQLite，不读取账本正文，不证明完整消息历史健康。Windows 可能调用只读 SID/ACL 核验工具，报告的 `permissionMetadataProbe` 会说明这一点。

`doctor --json` 仍用于原有工具版本和端点诊断，会执行相应程序。`inspect` 是更保守的第一步。

## 2. 核对指定聊天和 room

先按 [中文上手指南](QUICKSTART-ZH.md)选择准确服务与已有聊天，完成 attach。然后使用自己的 alias 和完整 room ID：

```text
agent-dialogue inspect --binding SELF --room FULL_ROOM_ID --json
```

将 `SELF` 换成有效的实际 alias，例如 `mac-reviewer`；将 `FULL_ROOM_ID` 换成 `r_...` 完整 ID。报告显示完整 binding ID/revision、harness、service/session/project/directory 和 room 成员 pins，供操作者与原聊天核对。标题、同名目录或最近窗口都不足以选择目标。

不带 `--binding` 时只汇总已有控制信息，不自动选择某段聊天。worker 文件中写着 ready 只是历史记录，默认会另列 `WORKER_PROCESS_NOT_PROBED`。远端 peer 同样标记未探测，不根据文件存在断言在线或离线。

本机完整诊断报告可能包含真实会话 ID、目录和项目名称，适合私有保存。它不会透传私钥、owner token、peer 传输配置、聊天正文和原始异常。公开问题报告继续使用最小脱敏信息，不直接上传整份本机报告。

## 3. 显式查询所选原生聊天

```text
agent-dialogue inspect --binding SELF --native --json
```

仅允许准确选择的本地 binding。查询核对原生服务身份、session、project 与 cwd，关闭查询 client，不调用 prompt、resume、queue start 或创建聊天，也不改变模型和审批。原生服务处理查询时可能更新内部元数据，报告会说明 `mayUpdateNativeMetadata`；本工具的通信 state 保持只读。

Kimi 的 session 查询可能加载冷会话，因此普通 `--native` 会停在 `KIMI_SESSION_LOAD_NOT_REQUESTED`，连 discovery/meta API 也不调用。确实要检查该服务拥有的原聊天时，额外明确：

```text
agent-dialogue inspect --binding KIMI_SELF --native --allow-session-load --json
```

`--allow-session-load` 仅用于所选 Kimi binding，不接管另一活动 TUI，不查询完整消息历史。

ZCode 的深查只验证本地已观察的准确宿主注册。`ZCODE_REGISTRATION_OBSERVED` 不证明桌面窗口现在在线；收件仍需原聊天调用 `dialogue_inbox`，`autoWake=false`。远端 binding 须在所属电脑检查，本版 `inspect` 不提供 SSH 深查参数。

## 4. 怎样理解结果

| 结果 | 意义 | 下一步 |
|---|---|---|
| `unconfigured` | 该专用空间尚未配置 | 按上手指南显式 setup、选服务/聊天；预检没有代做 |
| `ready-local` | 被检查的本地元数据自洽 | 阅读各项未探测结果；需要时显式 native 查询 |
| `blocked` | 格式、身份、路由或读取安全检查不能通过 | 保留原文件，按对应原因码核对版本、权限和 pins |
| `needs-review` | 有 pending、错误记录或锁等需核对证据 | 保留原消息/输入 ID；不自动清状态或换新 ID 发送 |

每项 `check` 给出稳定 `code`、`status`、证据来源、是否实际探测，以及结构化 `actions`。脚本应匹配原因码；说明文字可能改进。

退出码 0 包括尚未配置、警告和未探测；1 表示发现 `blocked / needs-review`；2 表示调用或路径配置无效。收到 0 也应读取 `overall` 和 `checks`，不能把未探测当成端到端连通。

已有 `m_UUID` 对账继续使用 `node flush --message m_UUID`；预检自身不执行 flush。`q_UUID`、原生 pending 和 MCP requestKey 仍需各自证据，不根据正文相同推断。

最新源码已增加[保留 binding 的生命周期和显式离线 v1→v2 启用](LIFECYCLE.md)。安全残留锁恢复、q→m 自动对账与通用升级回退仍是[稳定化计划](V0.3-STABILIZATION-PLAN.md)后续任务。`inspect` 没有 `--fix`，也不自动升级、删除锁、修权限或恢复进程。

## 5. 读取生命周期与启动证据

默认 inspect 兼容控制 store v1/v2。v1 或 v2 中没有独立 lifecycle row 的本地 binding 按默认 enabled 解释；v2 有 row 时只公开 `bindingRevision / desired / generation / changedAt`，不输出 changeNonce。远端 peer 的暂停状态须由所属节点提供，本地副本不冒充远端实时状态。

| 原因码 | 含义 |
|---|---|
| `BINDING_PAUSED` | 同一 active binding 的新 dispatch 已被持久暂停；这只是控制记录，不证明原生模型已停止 |
| `BINDING_DETACHED` | 历史绑定已停用，不能按 resumable pause 处理 |
| `LIFECYCLE_INVALID` | v2 lifecycle 格式或 binding revision 对不上，保留原字节并核对版本/状态 |
| `WORKER_LAUNCH_INVALID` | 启动记录格式或所属 binding 不符，不能据此 spawn/stop |
| `WORKER_LAUNCH_PENDING` | 启动、协作停止或结果核对仍未完成，保留原 reservation |
| `OUTBOX_UNKNOWN` | 原出站 m 结果未确认，不能换新 ID 发送；source paused 时不能直接 flush |

这些是只读本地记录，不运行 PID 所属进程查询。需要进程三态证据时由所属电脑的 `bridge status` 单独核对；其 `running:null` 表示未知，不能当作已停止。pause 回执的 `newDispatchBlocked` 与 `workerAcknowledged` 也分别表示准入提交和已记录 worker 确认。

首次启用 v2 须按[生命周期指南](LIFECYCLE.md)静止整个空间后显式升级；单个 binding paused、worker stopped 或 inspect 返回 `ready-local` 均不能证明所有写入者已离线。预检不代做升级，也不把 native pending、outgoing unknown、锁或启动未决自动修成可恢复。
