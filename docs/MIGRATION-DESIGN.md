# ST-06 首批：固定安装交接与受限回退

日期：2026-10-20。用户已授权规划并执行。本文件新增首批实施合同，不重排旧任务或覆盖已完成记录。ST-05选定恢复路径已验收，整体剩余的worker/未决scheduled token退休不作为本批已实现前提。

| 子项 | 目的和产物 | 状态 |
|---|---|---|
| MG-01 | 固定范围、版本矩阵、维护窗口与回退门禁 | 已完成（首片设计） |
| MG-02 | 安全完整state manifest、私有blob备份、副本SQLite校验 | 已完成（首片完整备份与平台合同） |
| MG-03 | 旧新安装/Node/backend/cache身份与准确停止证据 | 已完成（首片固定身份与实际prefix交接） |
| MG-04 | prepare/apply/verify/accept/rollback、CLI和安装说明 | 已完成（首片CLI、指南与新实际135） |
| MG-05 | 先红/独立审查、真实prefix/worker、平台CI与记录 | 已完成（首片十九组CI与最终双独审） |

## 范围与边界

首批只做同一台机器、同一用户、同一state路径、同一账本backend/cache下的独立新package目录切换。来源schema为2/3/4，目标固定4；来源程序按准确runtime摘要列入矩阵（63fba的57文件支持到3，1dd/c44的61文件支持到4，当前同内容独立prefix支持到4），不凭0.3.0字符串猜兼容。候选必须是实际调用命令所属的package与Node，旧package和Node准确路径由操作者明确提供。

不覆盖活动源码，不自动stop/resume/spawn，不重写peer、MCP、service或OS任务，不搬机器/私钥、换backend或多文件自动还原。普通新旧v4 writer不认识本批journal；维护锁R与C不能被称为全writer fence。操作者必须持续声明所有CLI、MCP、SSH接收/发送、worker及相关工具写入者静止，已知owner/locks还要独立验证。未知对象保持needs-review；不能放宽跨prefix进程归属。

先使用准确旧安装正常停止原worker。准备/作用阶段要求所有active binding已paused，已知runtime/stopped launch匹配且PID confirmed-dead，无worker/D锁、未知C、未决Windows launch descriptor。never-started binding可无runtime/launch；不完整的孤立launch/runtime拒绝。Windows迟到任务/实例退休不由“descriptor缺席”自动证明，操作者须按原已验证退出流程处理，未知仍拒绝。现有native/project外部作用不由通信state备份回退。

## 数据与依赖组织

程序、state、cache、bundle互不包含；旧新package必须是不同且不嵌套的目录。Node可共用准确realpath。旧prefix/cache保留，不复制或修改共享cache；hcom记录固定lock和所选dependency文件的路径/hash/身份，embedded没有外部账本binary。只读取安装与依赖元数据，不执行旧Node、setup、doctor、hcom、native或SSH。没有原发行tgz就明确只知道installed runtime digest，不补猜archive hash。

完整state以私有bundle保存：manifest.json、complete.json及blobs/SHA256。正文blob为0600，bundle根0700/Windows所属SID私有ACL，原mode单独记录；它不是可启动的dialogue/node.json副本。node私钥、完整DB/WAL/SHM、runtime、控制状态及checkpoint都纳入原路径集合。非空rollback journal、symlink/reparse、hardlink、FIFO、损坏/过宽/非所属对象、容量或复制变化均拒绝。旧bundle不覆盖、不修已有源权限、不递归chmod共享父树。

源manifest逐文件使用O_NOFOLLOW/NONBLOCK、BigInt fd身份、实际字节、前后stat及最终namespace复核；文件dev/ino/nlink/mode/uid/gid/size/ns时间/hash固定。目录dev/ino/mode/uid/gid/ACL固定，mtime/ctime/nlink不进语义（准确自有C创建/释放会改变父目录这些值）。唯一排除是当前nonce/pid/inode已验证的自有dialogue/.lock及其owner，不能glob排除未知lock/temp。

manifest按raw相对路径排序，整数转规范十进制字符串；SHA采用完整规范JSON UTF8，不用有256KiB预算的payloadHash。默认最多4096文件、每文件512MiB、总1GiB、manifest8MiB；超限保持原源并留下不完整证据，不裁剪。完整marker最后发布，verify必须同时匹配外部journal预先固定的manifest hash，不能只接受被改后内部自洽的bundle。

SQLite只在私有临时工作副本上做quick_check/固定header/schema核验，DB和存在的sidecars从已核blob重建；从不打开源DB或对源做checkpoint。embedded核ADLG/版本和实际表合同；hcom核非ADLG与固定events字段，不把这称为任意hcom格式兼容。plan/status不执行SQLite或创建临时副本。

## 维护事务和回退资格

外置journal记录唯一ID、用户/平台、state/cache/backend、两安装和Node身份、原manifest hash、源/目标schema、原/候选store hash、阶段、发布候选名、完整已应用/已恢复manifest与单向rollback资格。新文件原子发布并同步；独立私有R只串行同bundle恢复者，每个源作用阶段再持准确C。使用低层owned C，不调用会重写store的withStore空回调，不C→D，不持C递归调用upgradeStoreOffline。

将原schema变换提取成纯函数并复用现有规则：只补规定的map/版本，保留身份、room、pending和所有旧数据，冲突不覆盖；v4→v4不改原store字节。prepare固定原store raw bytes，apply生成唯一确定candidate bytes。旧source中已有pending/unknown/未完成MCP、forwarding/native/recovery等记录可原样备份并升级，但prepare时就将rollbackEligible永久设false，不因后来状态变化重新开放。

    plan（源只读、可查询已知PID，不持C）
      → prepare --offline（R/C、完整blob备份、只核副本DB、prepared journal）
      → apply --offline（严核原像、apply-prepared checkpoint、只发布确定store、applied完整后像）
      → verify（只读fs，核源/备份/安装/预期manifest，无hcom/native/SSH）
      → rollback --offline（仅未accept且eligible、准确全后像，原样发布旧store）
        或 accept --offline（先永久封闭rollback，不启动任何服务）
      → 操作者再按准确新安装逐项核聊天/pins、恢复worker、开放MCP/远端

自动回退资格只存在于backup→确定schema变换→本地只读核验的维护窗口。accept发生在第一次恢复写入者之前；一旦accepted，即使state还没变化也永久拒绝rollback。任何新增消息、runtime/receipt/cursor/tool-read、unknown作用、文件新增/替换/权限变化、artifact/backend/路径漂移都使全后像不匹配，拒绝覆盖。用户绕过流程直接调用原生或旧writer不受本journal强制隔离，持续offline声明不可省。

当前升级只有store.json变化，因此回退只恢复这一个文件的准确原字节（包括缩进/换行），不整树覆盖或交换两个活动node。回退前先记录rollback-prepared checkpoint；临时候选有固定随机名称/hash/所有权，发布失败保留。中断重试只接受精确前像或唯一规定后像，最终记录完整恢复manifest；第三像/变更journal/blob/新owner不覆盖、不危险回滚。原backup和已用候选证据保留。

## API、CLI和验证

模块分工：migration-files负责完整manifest/blob/副本DB；migration-installation负责固定package/Node/dependency；migration负责journal、owner门禁、纯schema变换调用与单store发布。CLI的mutating步骤都要求--offline和准确bundle；无--force/任意target/多文件restore绕过。

    migration plan --from-package PATH --from-node PATH [--json]
    migration prepare --from-package PATH --from-node PATH --bundle PATH --offline [--json]
    migration status --bundle PATH [--json]
    migration verify --bundle PATH [--json]
    migration apply|accept|rollback --bundle PATH --offline [--json]

stdout为闭合摘要，不含keys、body、owner nonce、可执行私有journal或原始错误；完整私有材料留bundle。作用命令可查PID/ACL，默认无模型/原生/SSH；不假装能扫描所有外部写入者。

先红矩阵覆盖：missing不初始化、未知版本/来源/重叠路径、真实old/new prefix、active/unknown owner和locks/descriptor、preexisting pending、原源无写入、SQLite/WAL/sidecars和源保持、blob/marker/manifest篡改、复制漂移、只store原bytes回退、checkpoint前后中断、第三像、新消息/worker启动/accept后拒回退、容量/rename失败与包内指南。真实owned child和安装包默认launcher验收与DI/合成PID分别记账，Windows用实际SID/ACL，生产8秒deadline不变。

私有执行新建.state/migration-20261020-vN，公开verification/migration-20261020-vN，研究action/exploration/index/session只追加、结果JSON新建。复用已固定Node24/26及CI矩阵，不使用GPU、真实模型或用户现有远端故障注入；首片不merge/tag/Release。NR旧结果与ST05整体状态保持，ST06只有本片证据齐全才报告对应范围完成。

## 实现审查增量（2026-10-20）

维护bundle必须与源state处于同一文件系统，且位于state/cache及两个安装目录之外。固定store候选保存在私有bundle内，避免将可重试temp放入源namespace而排除未知对象。候选发布不删目的文件：调用方在生成候选之前固定目的文件BigInt身份，生成和权限校验后再核完整源像、R/C、journal、安装和已知PID；rename同时核对原目的与已核候选身份。首journal发布要求目的不存在，不吸收后来出现的foreign journal。

仅本次新建candidate可调整为源store的mode/uid/gid或Windows owner/group/DACL，确认候选内容及权限完全符合后才替换；已有候选只验证、不修复。Windows复制操作使用固定系统PowerShell及既有8秒截止；源store和父目录不改。发布后再次核state与安装，发现变化保留checkpoint和新旧证据，不认证applied/rolled-back。

verify识别apply-prepared与rollback-prepared各自准确前像或唯一合法后像；它只说明文件证据可对齐，不自动完成中断事务、开放写入或重新启用rollback。操作失败时保留bundle、候选及维护记录，操作者仅在原offline条件仍成立时重试相同命令。
