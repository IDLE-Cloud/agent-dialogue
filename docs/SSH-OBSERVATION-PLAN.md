# SSH 只读观察：测试先行实施增量

状态：TESTS_FIRST。用户于2026-10-18授权继续远端观察，并要求“先写好相关测试”。本文件新增VIEW-11的实施细节，不改动已经完成的VIEW-01～10或历史验收结构。

## 契约与范围

显式配置文件指定local/ssh来源。SSH来源固定host别名、Node/CLI/state绝对POSIX路径、expectedNodeId和1～16个room的完整ID/revision/manifestHash。远端先校验节点公钥指纹并重算room manifest，裁剪所选room的有效协议事件和必需身份/回执；本地再次验证相同scope和一次性requestId后，交入既有纯projection。浏览器不能增加来源或触发任意SSH命令。

SSH仅执行固定`view-export --state-dir PATH`，请求通过stdin发送，禁止交互认证、端口转发和host key校验降级。使用现有操作者SSH账户和known_hosts，不新增公网服务、VPS、账号、密钥或模型调用；该账户的OS权限仍是访问边界，不提供新的多用户ACL。

首版采用有界完整快照：请求16KiB、响应16MiB、20,000个事件，超限报不可用，不静默截断。3秒远端轮询、每source一个在途进程，12秒超时；慢SSH不阻塞本机750毫秒刷新。断连保留最后成功快照并标记不可用。数据库替换、已有event ID被改写/删除时更新观察generation并重同步；不引入远端业务已读游标。

只支持已sealed的collaboration room；raw hcom/旧版未sealed room仍可在远端本机viewer中查看，本轮不跨SSH采集。原生完整聊天、内部Codex子agent、通信重试或进程supervisor不进入本轮范围。

## 新增任务

| ID | 任务 | 退出条件 | 状态 |
|---|---|---|---|
| OBS-01 | 先编写scope、transport、CLI/config和生命周期测试 | 新接口不存在时产生可复核red记录，覆盖下方矩阵 | 进行中 |
| OBS-02 | 只读导出协议与双端scope校验 | 重算manifest、正文/回执最小字段、nonce/node/room拒绝测试通过 | 待开始 |
| OBS-03 | 固定SSH transport与非阻塞采集 | 安全argv/stdin、限额、超时、断连恢复、退出清理测试通过 | 待开始 |
| OBS-04 | 配置/CLI/现有viewer集成 | 显式local+ssh混合、opaque source ID、页面保持只读 | 待开始 |
| OBS-05 | 本机fake-SSH全链路验收 | 走真实export CLI，验证网络替身/重连/readonly/hash/关联，不宣称双机已验 | 待开始 |
| OBS-06 | 打包、文档与跨平台CI | 安装包包含remote接口；原本机功能及新测试通过 | 待开始 |
| OBS-07 | 第二台真实机器观察验收 | 明确允许节点/room且SSH可达后，验证实际身份、范围与断连恢复 | 后续 |

## 测试矩阵

| 类别 | 必测行为 |
|---|---|
| room与节点 | 同名不同ID、revision/hash/公钥指纹错误、未sealed、篡改成员但伪造原hash均拒绝 |
| 正文范围 | thread/frame/wire的room与pins一致；不发送其他room或raw hcom正文；未知wrapper字段剥除 |
| 元数据范围 | bindings/peers/inbox/outbox/worker receipts/pending只保留选定room事件；秘密字段与业务全局cursor不出现在网络快照 |
| 协议 | 一次性nonce、单一JSON、版本/字段/UTF-8字节与事件数上限；恶意响应被本地再次拒绝 |
| 关联 | q→正式消息与wire副本保持；范围外父消息仅保留悬空引用，不补采正文；历史expectedSession不改写 |
| 进程 | 固定SSH命令安全引用，BatchMode/StrictHostKeyChecking；不继承模型身份，stderr不泄漏；关闭viewer终止自己的在途采集 |
| 恢复 | 首次失败、旧快照失效、同ID正文变化、源替换、空库第一条、晚到回执、慢远端与本地独立刷新 |
| 真实只读 | export前后比较DB/WAL/SHM、store/node/worker/cursor；缺失目录不初始化；不运行hcom/native API |

## 组织与记录

新测试为`tests/viewer-observation.test.mjs`、`viewer-ssh.test.mjs`、`viewer-remote-cli.test.mjs`；拟实现`lib/viewer/observation.mjs`、`readers/ssh.mjs`、`config.mjs`、`export-cli.mjs`。合成fixture不含真实凭据、host、state路径或原生聊天记录。red/green和集成结果保存在新的`verification/ssh-observer-*`目录，旧结果不覆盖。公开安装说明采用占位路径；本轮不自动联系私人Remote档案中的主机。
