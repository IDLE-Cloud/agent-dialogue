# 固定安装交接、私有备份与受限回退

本页对应 ST-06 首批开发实现；稳定 Release `v0.2.0` 没有这些命令。实现合同见 [MIGRATION-DESIGN.md](MIGRATION-DESIGN.md)，实际安装与平台验收以 [STATUS.md](STATUS.md) 的对应批次为准。本页不表示新一轮 CI、真实机器迁移或 RC 已经通过。

## 1. 先确认本次交接的范围

本入口处理**同一电脑、同一用户、同一个 state 路径、同一个 ledger backend 和 cache 路径**下，从一个固定 package 目录切换到另一个独立 package 目录。旧新 package 不得相同或互相包含；package、state、cache、备份 bundle 也不得互相包含。bundle 必须与 state 位于同一文件系统卷，父目录必须已经存在并属于当前用户，POSIX 为私有 0700 目录，Windows 为当前用户 SID 的私有 ACL。bundle 本身由 `prepare` 新建，不能指向已有目录。

候选是**实际执行 migration 命令的 package 和 Node**。`--from-package` 指向原安装中包含 `package.json`、`bin`、`lib` 的 package 目录，`--from-node` 指向原安装使用的准确 Node 文件；它们不是聊天目录或全局 prefix 顶层。Node 可以共用同一个准确文件，package 目录必须独立。包版本都显示 `0.3.0` 不足以证明兼容，程序会核完整 runtime 内容、文件身份和 Node artifact。原 Node 若不是当前进程的同一文件，记录的是 artifact 身份，不会为了猜版本执行它。

来源控制 schema 仅支持 2/3/4，目标固定为 4。还须满足程序内容目录：

| 来源程序的完整 runtime 摘要 | 本入口允许的来源 schema | 目标 |
|---|---|---|
| `56f96305f7234e922fd277bb402210b01e978e2f50bc40652d071fcb1093c94d`，已审 63fba 安装 | 2、3 | 4 |
| `7ec88027e61bba31be457b5ed05c17863d214e2ed4a4f7878a8844ce08efd19d`，c44/1dd 同 runtime 安装 | 2、3、4 | 4 |
| 与当前候选完整 runtime 内容完全一致的独立旧 package | 2、3、4 | 4 |

未知程序内容、schema 1、不同 backend、不同机器或用户不能借此入口迁移。hcom 还会固定所选依赖文件及 lock；Windows 保持 embedded。程序不下载或更新依赖、不修改 cache。先将固定候选装到独立目录，并保留旧安装与包的准确来源；不要覆盖活动 worker 的源码或用可变分支名代替固定内容。

## 2. 从原安装进入维护窗口

先使用**准确旧 Node 和旧 CLI**，对这个空间的所有本机 active binding 正常 pause、stop，再核对确切 PID/token 已退出、状态为 stopped/error、matching stopped launch 和锁证据。曾经启动过的 worker 必须有完整退出证据；never-started binding 可以没有 runtime/launch。远端 binding 的本地副本不是应停止的本机 worker。

新 prefix 按自己的绝对 worker 路径核验归属，不能接管另一个 prefix 的旧活进程。出现 unknown、PID 复用、不完整记录、未决 Windows scheduled descriptor 或未知锁时，保留证据，继续用原已验证退出流程处理；不要放宽归属检查、按名称杀进程或按文件年龄删锁。更早且没有 cooperative stop 协议的安装不因提供了路径就变成已支持的退出来源。

同时静止该空间的 CLI 写入者、MCP send/inbox、SSH `node receive`/flush 和相关聊天工具调用，并协调 peer 暂停投递。只维护这一个通信空间；无需停止整台电脑的 SSH、FRP 或其它项目服务。pause 仍允许本地 queue 和远端验签入账，stop 仍允许 enabled binding 的直接入口；它们都不能单独证明全部写入者静止。已经受理的模型执行也不会被 bridge stop 取消，操作者还须确认它不会继续写通信状态。

每次 mutating 命令的 `--offline` 都表示操作者声明维护窗口仍然成立。程序会另外拒绝它发现的 live/unknown owner、锁和未决 launch；私有维护锁只串行同 bundle 的维护者。普通旧 MCP/CLI/SSH writer 不检查本 journal，程序没有自动发现所有外部写入者或跨机器阻止同 node 双在线的能力。

## 3. 选择准确目录和命令

以下都是占位路径，先替换为实际固定安装和原空间。当前 CLI **没有通用 `--state`、`--cache` 参数**；使用 `AGENT_DIALOGUE_STATE_DIR`、`AGENT_DIALOGUE_CACHE_DIR`、`AGENT_DIALOGUE_LEDGER`。保留原服务描述、hcom override 及其它原环境，不在维护过程中重新选择原生服务或聊天。

POSIX 示例，原空间 backend 若为 hcom 就设置 hcom，若为 embedded 就保持 embedded：

```bash
export AGENT_DIALOGUE_STATE_DIR=/absolute/private/existing-space
export AGENT_DIALOGUE_CACHE_DIR=/absolute/private/existing-cache
export AGENT_DIALOGUE_LEDGER=embedded

migration_old_package=/absolute/old-prefix/lib/node_modules/@idle-cloud/agent-dialogue
migration_new_package=/absolute/new-prefix/lib/node_modules/@idle-cloud/agent-dialogue
migration_old_node=/absolute/old-node/bin/node
migration_new_node=/absolute/new-node/bin/node
migration_bundle=/absolute/private/maintenance/handoff-001

dialogue_old() { "$migration_old_node" "$migration_old_package/bin/agent-dialogue.mjs" "$@"; }
dialogue_new() { "$migration_new_node" "$migration_new_package/bin/agent-dialogue.mjs" "$@"; }
```

例如本机 active alias 为 alice、bob 时，分别用原安装处理；替换为实际全部本机 alias：

```bash
dialogue_old bridge pause alice --json
dialogue_old bridge stop alice --json
dialogue_old bridge pause bob --json
dialogue_old bridge stop bob --json
dialogue_old bridge status
```

Windows PowerShell 示例，package 目录按实际安装布局填写：

```powershell
$env:AGENT_DIALOGUE_STATE_DIR = 'C:\private\existing-space'
$env:AGENT_DIALOGUE_CACHE_DIR = 'C:\private\existing-cache'
$env:AGENT_DIALOGUE_LEDGER = 'embedded'

$migrationOldPackage = 'C:\tools\old-prefix\node_modules\@idle-cloud\agent-dialogue'
$migrationNewPackage = 'C:\tools\new-prefix\node_modules\@idle-cloud\agent-dialogue'
$migrationOldNode = 'C:\tools\old-node\node.exe'
$migrationNewNode = 'C:\tools\new-node\node.exe'
$migrationOldCli = Join-Path $migrationOldPackage 'bin\agent-dialogue.mjs'
$migrationNewCli = Join-Path $migrationNewPackage 'bin\agent-dialogue.mjs'
$migrationBundle = 'C:\private\maintenance\handoff-001'

& $migrationOldNode $migrationOldCli bridge pause alice --json
& $migrationOldNode $migrationOldCli bridge stop alice --json
& $migrationOldNode $migrationOldCli bridge pause bob --json
& $migrationOldNode $migrationOldCli bridge stop bob --json
& $migrationOldNode $migrationOldCli bridge status
```

上述操作失败时先停下来核对；不要继续下一步。Windows 目录应事先使用所属用户私有 ACL 准备，命令只为新建的 bundle/文件设置私有权限，不会修已有源目录权限，也不会递归重置已有 state 或安装目录。生产 ACL 检查的每操作 8 秒期限保持。

## 4. plan → prepare → apply → verify

下面每一步都单独执行并检查退出码和结果。全部 migration 命令由新候选执行；state/backend/cache 始终保持原值。

先生成只读计划：

```bash
dialogue_new migration plan --from-package "$migration_old_package" --from-node "$migration_old_node" --json
```

```powershell
& $migrationNewNode $migrationNewCli migration plan --from-package $migrationOldPackage --from-node $migrationOldNode --json
```

`status: ready` 只表示当次文件与已知 owner 检查满足计划条件。plan 不持 C、不创建 state/cache/bundle、不改源文件、不执行旧 Node、hcom、原生服务或 SSH；已知 PID 查询次数在 `effects.processQueries` 中说明。`ledgerValidation: not-probed` 表示账本尚未做副本 SQLite 校验，不能把 ready 当作 DB 完整性或端到端聊天连通证明。

维护窗口成立后创建新私有备份：

```bash
dialogue_new migration prepare --from-package "$migration_old_package" --from-node "$migration_old_node" --bundle "$migration_bundle" --offline --json
```

```powershell
& $migrationNewNode $migrationNewCli migration prepare --from-package $migrationOldPackage --from-node $migrationOldNode --bundle $migrationBundle --offline --json
```

prepare 核完整源 manifest、blob 字节、复制前后像和安装身份，只在私有工作副本上校验 SQLite；不会打开源 DB、checkpoint 源 WAL 或执行 hcom。node 私钥、DB/存在的 WAL/SHM、runtime、控制状态和原 checkpoint 都按原路径纳入备份。非空 rollback journal、symlink/reparse、hardlink、FIFO、容量超限或复制漂移会拒绝，留下的不完整 bundle 不能冒充完成备份。

成功进入 `prepared`，原 store 未升级。完整数据在 `snapshot/blobs/SHA256`，manifest/complete 与外置 journal 互相固定；它不是一个可运行的 state 目录。bundle 含私钥和聊天数据，只私有保存，不上传 Git、room 或公开报告，也不要把 blobs 重建成第二个活动 node。

保存确定的目标 store：

```bash
dialogue_new migration apply --bundle "$migration_bundle" --offline --json
```

```powershell
& $migrationNewNode $migrationNewCli migration apply --bundle $migrationBundle --offline --json
```

apply 只发布该计划确定的 `store.json`。来源 2/3 升为 4，来源已是 4 时保留原 store 字节；其它原文件、身份、聊天、room 和 pending 保留。它不启动 worker、提交原生输入或重放消息。

随后核验当前准确后像：

```bash
dialogue_new migration verify --bundle "$migration_bundle" --json
dialogue_new migration status --bundle "$migration_bundle" --json
```

```powershell
& $migrationNewNode $migrationNewCli migration verify --bundle $migrationBundle --json
& $migrationNewNode $migrationNewCli migration status --bundle $migrationBundle --json
```

verify 只读核备份、安装和完整源像；`status: verified` 对应这次维护记录的准确像。status 仅显示 journal 阶段，不能替代 verify。两者不主动联系原生服务或 SSH，也不会查询模型是否完成。

## 5. 选择回退，或先 accept 再开放写入者

`rollbackEligible` 在 prepare 时按原证据固定。已有 pending/nativePending/outgoingPending、worker error、未完成 MCP/outbox/inbox/forwarding/native 或恢复 checkpoint，可以保留备份并升级，但会使本计划的回退资格永久为 false。后来清 pending、补 receipt 或状态看起来恢复正常，不会把这个计划重新变成可回退。

仅当尚未 accept、`rollbackEligible: true`、完整源像仍精确匹配已记录后像，且全部写入者仍离线，才能选择：

```bash
dialogue_new migration rollback --bundle "$migration_bundle" --offline --json
```

```powershell
& $migrationNewNode $migrationNewCli migration rollback --bundle $migrationBundle --offline --json
```

成功 `rolled-back` 只恢复备份中原 `store.json` 的准确字节，包括原缩进/换行；不还原整树、不删除新消息、不覆盖当前 ledger/runtime，也不降级已产生的新作用。原旧安装仍保留，之后是否使用它恢复运行，由操作者另外核验；不会自动启动。不要手改 version、复制整个旧目录覆盖现空间或用新消息 ID 重发来回退。

决定继续使用候选时，须在第一次恢复 writer **之前**执行：

```bash
dialogue_new migration accept --bundle "$migration_bundle" --offline --json
```

```powershell
& $migrationNewNode $migrationNewCli migration accept --bundle $migrationBundle --offline --json
```

`accepted` 永久封闭本计划 rollback，即使 state 尚未改变。accept 不启动任何服务或 worker、不解除 pause、不改 MCP/peer 路径。需要处理原 unknown 时，在 accept 后按 [q/远端对账](RECOVERY.md)或[原生恢复指南](NATIVE-RECOVERY.md)继续，保留同一 q/m/input 身份；证据不足时继续 needs-review。

然后由操作者核对新安装下的原服务、完整 session、项目目录、room pins 和私有 scope，按[生命周期指南](LIFECYCLE.md)明确 resume，并分步开放该空间 MCP、CLI 和远端投递。新安装不会替其它机器改 SSH 接收端路径，不会改模型里的旧绝对命令、MCP command 或 Windows OS 任务；实际配置交接须由操作者明确完成。不要删除仍被其它聊天或接收路由引用的旧安装。

开放写入者后，正常 runtime 和 ledger 会变化。`migration verify` 仍比较维护窗口的冻结后像，不是运行后的健康检查；日常使用 inspect、bridge status 和[查看器](VIEWER.md)。

## 6. 中断和拒绝时保留什么

| 观察 | 处理 |
|---|---|
| `prepared` | 原 schema 未改变；保留 bundle，在持续离线条件下再 apply |
| `apply-prepared` / `rollback-prepared` | checkpoint 已保存，不能只凭阶段断言 store 是否已发布；同一命令重试只接受规定的前像或后像 |
| `applied` | 候选后像已记录；继续只读核对，再在 rollback 与 accept 中选择 |
| `accepted` / `rolled-back` | 本计划回退资格已关闭；不会自动恢复运行 |
| needs-review、非零退出、安装/权限/源像漂移 | 保存旧新安装、bundle、原错误和当前 state；不追认第三像，不覆盖、不清锁、不生成新 ID 重放 |

新增消息、cursor/receipt/tool-read、worker 启动、文件新增/替换、权限变化或 installation/backend/cache 路径漂移，均可能使精确后像不再成立；此时原 bundle 不能被“刷新”成新基线。已经发生的原生或远端作用继续按原证据对账。本入口不提供忽略差异的 force 或整树 restore。

失败候选、原始 checkpoint、quarantine 和私有 bundle 保留，不为使重试变绿而删改它们。进程崩溃留下的维护 R 或未知 worker/launch，不按年龄自动退休。`--json` 也不保证失败 stderr 是结构化内部原因码；当前 migration CLI 失败输出固定脱敏说明，脚本先检查退出码。

该流程不迁移原生聊天、不复制另一台活动机器的私钥、不更换 backend、不承诺所有旧版本或任意 hcom DB 都兼容。跨机、跨用户、已有新作用后的降级、完整多文件还原和固定 RC，继续按[稳定化计划](V0.3-STABILIZATION-PLAN.md)另行验收。
