# ST-05 原生输入与遗留锁恢复合同

日期：2026-10-20。用户已授权规划、分析并实施。本文是ST-05后续软件设计，不重排既有任务或覆盖第一批验收；ST-06完整迁移/回退、真实项目试用和RC另行验收。

## 本批范围与顺序

| 子项 | 目的与产物 | 实施状态 |
|---|---|---|
| NR-01 | 明确v4写入隔离、原生证据与锁退休合同 | 已完成 |
| NR-02 | 原生完整证据、先持久intent、停止后receipt修复 | 已完成 |
| NR-03 | 遗留C/D锁只读计划与显式offline证据转存 | 已完成 |
| NR-04 | CLI、预检摘要、包与使用说明接入 | 已完成 |
| NR-05 | 独立审查、先红/绿、真实子进程故障与平台CI | 已完成 |

复用现有binding、ledger、原生adapter、D→短C、精确文件身份、immutable发布和前后像checkpoint。worker锁及不明Windows scheduled launch第一期保持needs-review；开放它们之前须有原token不可复用和准确运行instance证明。本批不接管活动TUI、更改模型/审批或自动拉起原生服务。

## 显式v4与原生来源

新强制语义由显式offline目标4启用。默认目标仍为2；旧v1/v2/v3 writer拒绝v4，不以旧writer忽略的新map充当隔离。所有writer仍须静止，升级保留node、room、账本、forwardings、MCP和旧pending；不给历史pending补猜来源。已有未知nativeIntents字段拒绝覆盖，v4不能降级。

v4新增严格nativeIntents，以稳定input ID为key。每行保存version、inputId/eventId、binding/revision、room、完整event/frame/binding/route hash、promptHash、rendererVersion、phase、attemptId/attempt、createdAt、receipt和recovery。promptHash统一为payloadHash(promptText)，即完整字符串canonical JSON SHA256；正文不复制进控制状态。

phase为prepared、submit-started、not-submitted、admitted。只有admitted有准确receipt和可选recovery。not-submitted只来自adapter明确的作用前拒绝，不能由超时或空查询推断。新尝试复用稳定input ID，须先确认旧pending已清且上次确为not-submitted；旧或不明pending保持待核对。

## 正常原生准入

    持所属D，核准确event/frame/recipient/room/service/session及binding
    短C保存完整native intent与prompt hash
    所属worker持久runtime.pending
    短C条件取得prepared→submit-started追加权
    只调用一次原生prompt
      明确notSubmitted：先保存not-submitted，再持久清pending
      未知：只查准确原生input，不重复prompt
    确认admitted后短C保存固定receipt及对应签名inbox结果
    正常worker一次保存receipt、pending移除与cursor进度

旧schema准入保持原合同。v4未知结果不使用仅ID命中的fallback；完整证据不足保留pending。intent或pending准备失败不开始prompt；作用后写入失败保留原关联。

## 证据检查与停止后修复

    bridge native-evidence ALIAS --event N [--native [--allow-session-load]] [--json]
    bridge native-reconcile ALIAS --event N [--allow-session-load] [--json]

默认evidence只读本地store/runtime元数据，不创建空间、获取D或打开原生服务，也不以查询补历史来源。显式native查询和native-reconcile才取所选D；要求v4、准确local active binding已paused、匹配stopped/error runtime和stopped launch、confirmed-dead、无所属worker锁或未决launch。Kimi额外要求allow-session-load，未给时不执行discovery/meta/session。ZCode tool-read不具备native admission语义。

核准确原ledger event、完整hash及当前pins后，C外调用强证据接口。Kimi/OpenCodeV1可查准确ID的持久user消息并核完整单text；其它adapter只有满足相同原始合同才开放，否则unsupported。近期ID命中、内存queue、部分正文、404或未知错误均不证明结果。新intent保存原prompt hash，可直接核原生完整文本，不按当前prefix重渲染倒填历史来源。

修复仅补准确event的admitted receipt、移除匹配runtime.pending，并同C核必要的remote inbox关联。cursor、nativePending、outgoingPending、其它receipts、owner/status/error保持。

    持D，读停止runtime前像与owner/lifecycle/pins
    C外查完整positive evidence，再核前像
    短C提交固定receipt和checkpoint（pre/post/pending/owner hashes及nonce）
    保持D，复核停止证据，仅向准确前像发布确定后像
    短C核后像并标runtime-committed

中断重试只认前像或确定后像，第三像拒绝，receipt时间固定。对账不prompt、drain、queue/start、exchange、spawn或自动resume；两文件提交不是原子事务。

## 遗留锁计划与有限退休

只支持规范C或准确binding的D锁，不接受任意路径。plan完全只读，核私有目录/owner、closed v1、regular/no-symlink、有界UTF-8、BigInt身份和PID三态。C/D nonce不是worker token；只有ESRCH证明当前不存在，PID存在、复用、权限或查询失败均拒绝。

    lock plan [--binding ALIAS] [--output PRIVATE_FILE] [--json]
    lock retire --plan PRIVATE_FILE --offline [--json]

C须所有local active bindings已paused，D须所属已paused。apply另要求全空间offline声明，核所有已知worker、launch及锁owner无live/unknown producer。不能为修遗留C先withStore，或为修D先withDispatch自锁。

apply用独立R恢复互斥，R只串行恢复者，普通writer不检查R，所以不能代替offline，残留R不自动破锁。先持久prepared checkpoint再复核原锁，单次rename到同卷私有quarantine，核inode/owner hash后标retired。原证据保留，不unlink/递归删除或修已有权限。

目录rename不宣称可移植原子CAS/no-replace；唯一私有目标、R与offline是前提。重试只认原前像或准确quarantine后像，原路径出现新owner绝不覆盖/删除，不危险回滚。其它锁、store、runtime、ledger保持，状态仍paused，不启动或重放。

## 先红验证与资源

用隔离owned state、embedded ledger、fake loopback和本轮子进程；不通过重启正式harness制造故障，不调用模型或SSH。锁须真实owned child取得C/D后被结束并留下，不能用finally清理伪装崩溃。Windows用真实SID/ACL，生产权限deadline保持。

必要合同：完整输入与同ID错误正文/session/role、旧pending缺来源、Kimi加载授权、unsupported fallback、准备失败零POST、notSubmitted重试与未知零重发、owner/pins漂移、checkpoint中断和第三像、容量/rename失败、原字段保持。锁另覆盖live/unknown、坏owner、权限/symlink、plan后替换、R竞争、quarantine后新owner与幂等。

新模块按职责为native-record、native-proof、native-recovery、lock-recovery，复用tests与包smoke。私有证据新建.state/recovery-native-20261020-vN，公开新建verification对应版本；研究action/exploration/index/session只追加、结果JSON新建，旧失败与任务结构不改。阶段、平台和真实部署分别记账。

## 实现核验补充：2026-10-20

默认native-evidence的精确读取范围是store元数据，不读取runtime；主动native查询才核停止runtime/owner。获得D后重复阶段preflight，query后对原intent完整outcome及签名inbox关联做CAS；本地instance/request/ack与跨机external/inform各按已有准确wrapper核验。CLI evidence采用闭合DTO，不输出promptHash；异常固定脱敏，私有锁plan只写操作者指定的既有私有目录。

验证环境修正与生产源码分开：Windows proof fixture使用平台规范路径和Kimi实际canonical projectID，首个ACL setup失败保留原因不确定性；CI新增独立只读WindowsPowerShell元数据初始化和计时，生产8秒期限不变。私有记录脚本曾递归影响并行测试安装权限，原FAILED保留，禁止对共享证据父树chmod；同一tgz另起prefix核内容/权限与正常stop。完整阶段结果见各独立verification快照，不覆盖初始设计与失败。

本批NR-01～05已完成选定范围验收，准确候选4108b08e41ba4ea77ed4e1f57f3605b9c62073aa的九组CI全success，运行源码等于c44bc9d实现。[最终报告](https://github.com/IDLE-Cloud/agent-dialogue/blob/codex/multinode-adapters/verification/native-recovery-20261020-v3/README.md)分别记录平台skip、旧writer fence与实际安装证据；ST05整体仍进行中，worker/scheduled token退休、V2/Codex强未知恢复与ST06后续边界不变。
