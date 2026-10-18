# 本地对话查看器

`agent-dialogue view` 在本机浏览器中展示已经交换的消息、准确的节点/绑定/原生会话身份、明确回复关系和投递证据。它是观察工具；关闭页面或查看器进程不影响通信。无需 VPS、额外模型账号或 hcom 查询进程。

此功能属于 **v0.3 开发分支**，不在稳定版 v0.2.0 中。安装时选择分支：

```bash
npm install -g 'git+https://github.com/IDLE-Cloud/agent-dialogue.git#codex/multinode-adapters'
```

需要 Node.js **22.13 或更新的受支持版本**（CI 覆盖 Node 22/24/26）。查看器使用内置 `node:sqlite`，没有 npm 运行依赖；22.13 起该模块无需额外启动 flag。参考 [Node 官方 SQLite 文档](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)。

## 打开已有通信空间

```bash
# 当前空间由既有 AGENT_DIALOGUE_STATE_DIR / AGENT_DIALOGUE_SPACE 配置选择。
agent-dialogue view

# 明确选择两个本机节点的 state；指定 --source 时不再隐式加入默认空间。
agent-dialogue view \
  --source 'Laptop=/absolute/path/to/node-a-state' \
  --source 'Workstation=/absolute/path/to/node-b-state'

# 默认随机可用端口，也可指定本地端口。
agent-dialogue view --port 9137
```

打开终端打印的完整访问链接。它在 `127.0.0.1` 设置本次查看器专用的 HttpOnly/SameSite cookie 后移除 URL 中的访问 token。浏览器需要允许该站点的本地 cookie。终端按 Ctrl+C 只关闭查看器。重启后使用新链接；旧 cookie/链接不再有效。

缺失的空间会显示“来源或账本不存在”，不会自动创建 state、hcom 数据库、节点身份或绑定。不接受 `--host 0.0.0.0`。同一真实目录不能用不同标签重复登记。网页无法增加来源、提供任意路径或执行 SQL。

## 汇总本机与 SSH 来源

开发分支现在支持显式登记的 SSH 只读来源，浏览器仍运行在当前电脑的 `127.0.0.1`。远端需要安装同一开发分支和 Node.js 22.13+，不需要启动 viewer、模型或新的网络服务。当前已完成本机 fake-SSH 全链路验收；第二台真实机器的身份、网络与权限仍须单独验证。

先在**已有通信节点**上确认该空间的 node 和 sealed room。以下命令的 `AGENT_DIALOGUE_STATE_DIR` 应指向同一份现有 state：

```bash
# 在远端交互终端执行：得到真实 Node 二进制和安装后的 CLI 文件路径。
node -p 'process.execPath'
node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v agent-dialogue)"

# 已有节点的公开身份，以及当前 room 的完整身份。
AGENT_DIALOGUE_STATE_DIR='/absolute/path/to/remote-state' agent-dialogue node status
AGENT_DIALOGUE_STATE_DIR='/absolute/path/to/remote-state' agent-dialogue bindings
```

配置的 `expectedNodeId` 取自 `node status` 的 `node.nodeId`；`rooms` 每项复制 `bindings` 中所选 `rooms[]` 的 `id`、`revision`、`manifestHash`，不能用名称或截短 ID。只需把这些字段放进配置，不必把完整的 bindings/worker 输出复制到别的电脑。当前 `room create` 会生成 sealed room；旧 room 缺少 revision/hash 时，不要自行填写或只修改旧 room，先按 [节点通信说明](NODES.md) 建立并接受明确的 collaboration room。远端观察要求所选 room 在该节点有本地参与者。

在观看的电脑保存例如 `viewer-sources.json`，替换其中路径、node ID 和 room pins：

```json
{
  "version": 1,
  "sources": [
    {
      "kind": "local",
      "label": "Laptop",
      "path": "./local-state"
    },
    {
      "kind": "ssh",
      "label": "Research server",
      "destination": "research-server",
      "executable": "/absolute/path/to/node",
      "cli": "/absolute/path/to/agent-dialogue/bin/agent-dialogue.mjs",
      "stateDir": "/absolute/path/to/remote-state",
      "expectedNodeId": "n_<node status 的完整 64 位小写十六进制 hash>",
      "rooms": [
        {
          "id": "r_<完整 room UUID>",
          "revision": 1,
          "manifestHash": "<该 room 的完整 64 位小写十六进制 hash>"
        }
      ]
    }
  ]
}
```

```bash
agent-dialogue view --config ./viewer-sources.json

# 可同时添加本机来源；配置与 CLI 合计最多 16 个来源。
agent-dialogue view --config ./viewer-sources.json \
  --source 'Additional local=/absolute/path/to/another-state'
```

配置是 version 1 的严格 JSON：顶层只有 `version`、`sources`，每个来源只接受示例中的字段，不接受任意 SSH 参数或执行命令。文件最大 64 KiB；label 为 1–64 个可显示字符。`local.path` 相对**配置文件所在目录**解析；CLI `--source` 的相对路径相对当前工作目录解析。SSH 的 `executable`、`cli`、`stateDir` 必须是远端绝对 POSIX 路径，`~`、`$HOME` 和远端 PATH 查找不会代为展开。`executable` 是 Node 二进制，`cli` 是 JavaScript 入口文件，不是 shell 包装器。同一本机真实目录或相同 SSH destination/stateDir 不能登记两次；同一远端的多个 room 放进同一个 `rooms` 数组。

`destination` 使用现有 `~/.ssh/config` 的主机别名或 `user@host`。非默认端口、密钥等继续由该 SSH 配置指定。采集固定使用 `BatchMode=yes`、`StrictHostKeyChecking=yes` 和 `ClearAllForwardings=yes`，不弹密码、不自动接受新 host key、不新建转发。首次连接所需的 host key 应由操作者先通过可信渠道核实并登记到现有 known_hosts；未知或变更的 key 会令来源不可用。

SSH 仅执行绝对 Node 路径加绝对 CLI 路径的固定 `view-export --state-dir PATH`，请求通过 stdin 发送。导出端和接收端都校验本轮 nonce、node 公钥对应的 ID、room revision/hash、重算 manifest 后的成员，以及消息签名和事件归属。node 私钥、服务配置、SSH transport、worker token、全局 cursor、未选择的 room/绑定/回执均不传输。raw hcom 和未 sealed 的旧 room 仍可在该机器的本地 viewer 查看，本轮不跨 SSH 导出。所选 room 的协议记录损坏或 pins 不一致时，整次采集失败，不返回部分成功快照。

这里的 room scope 是**查看器的采集约束**。它复用当前操作者 SSH 账号的文件权限，不会把该账号变成只能读取所选 room 的新权限账户；需要面向其他人的隔离访问时，应另行配置专用 OS/SSH 账号和服务端权限。

远端默认每 3 秒尝试一次，每个来源最多一个在途 SSH 进程，执行时限 12 秒。慢远端不会阻塞本机 750 毫秒的刷新。断网或校验失败后保留最后成功的数据，并标记来源不可用；页面采集时间为本机最后成功接收时间，旧正文仍可读不代表远端当前在线。恢复后重新校验并更新已有消息/回执；源替换、已采集事件删除或同 ID 内容改写会使页面重新同步。关闭 viewer 会终止它自己的在途采集，不终止通信 agent。

每个 SSH 来源每次发送完整的有界快照：请求最多 16 KiB，每次 1–16 个唯一 room，响应最多 16 MiB、20,000 条**所选事件**，每条协议记录最多 120,000 UTF-8 字节。超过限额明确报不可用，不静默截断；未选择的历史不占用事件数量额度。本轮尚无远端增量分页或远端缓存数据库。配置变更后重启 viewer，使用新打印的访问链接。

## 阅读与导出

- 左侧选择 room。同名 room 仍按实际身份分别显示；旧版 room 保留来源范围。
- 中间按发送端来源事件顺序和明确回复关系阅读。跨机器时间仅作辅助，不能保证全局时钟一致。
- 点击消息查看完整 node、binding、revision、session ID 和每份证据；点击回复引用定位原问题。原问题在当前页或筛选之外时单独加载引用预览，缺失时明确提示。
- 可按来源、参与者绑定、证据状态及正文搜索筛选。每页最多 100 条，支持向前加载历史。
- 导出 JSON/Markdown 包含**当前 room 与筛选条件下、已登记来源的全部历史**，不是仅当前显示的一页。导出记录范围、采集时间与证据引用；不会读取原 harness 的完整历史。

来源筛选选择“在该来源存在副本的逻辑消息”，会保留同一消息已经合并的其他来源证据。导出通过 `sourceFilterMode: message-membership` / `evidenceScope: all-collected-copies` 明确此语义，并包含每个被引用来源的采集时间与可用性。

本地排队请求只有通过同一来源 worker 的 `forwarded` 回执，精确对应到正式事件、路由与正文后才会折叠。重复 q ID、路由不符或缺少回执会保留异常记录。跨节点副本按原始节点、全局消息 ID、规范 payload 和签名合并；同 ID 不同内容/room/成员 pins 会保留冲突。相同正文或相近时间不会触发合并。

普通 hcom 消息归入来源内的独立 thread，保留端点与账本证据；没有准确绑定时，原生会话显示未知。它们不会仅凭 thread 名称与签名 collaboration room 合并。群发的多个接收端作为原始收件人保留，不冒充一个准确原生会话。

正文以不可信文本显示。HTML、脚本、Markdown 图片和类似命令的文字均不执行，也不自动加载外部图片。

## 如何解释证据

| 页面状态 | 表示什么 |
|---|---|
| 本地排队 | hcom 中存在实际 submission 事件 |
| 账本已记录 | 存在正式消息的本地账本事件 |
| 后台已转发 | worker 的精确 q→正式消息映射 |
| 对端已收妥 | 发送端 bridge 验证后的 `remote-stored`，或接收端 inbox/账本记录 |
| 原生已受理 | 接收端原生 input ID 与 admitted 回执 |
| 已有关联回复 | 反向参与者发出了明确引用该消息的回复 |
| 待确认 / 状态未知 / 已拒绝 | 对应的 pending、unknown、rejected 记录；详情中保留来源 |

证据可以并存，均不等于“模型已读”“正在思考”或“任务完成”。当前 outbox 不保存签名 stored 回执本体；查看器展示 bridge 验证后的记录，不声称独立复验该回执签名。账本中保留的 wire 消息签名可以利用已采集的节点公钥复验，详情注明 verified/invalid/not-collected。

binding 当前已经 detach，并不会抹去此前成功投递。来源读取失败时保留最后成功快照并显示采集时间，不能据此推断对方离线或消息未发生。控制 JSON 缺失/损坏会单独提示；其他来源仍可阅读。

## 只读实现与实时更新

查看器不调用 `hcom events`。对 pinned hcom 0.7.30 的受控验证发现，该命令在空空间和已有空间均可能创建/改动文件；直接 SQLite 只读连接也可能修改活跃 WAL 的 SHM 读标记。

reader 用只读文件描述符读取 DB/WAL，核对复制前后文件身份、大小和纳秒时间戳，再在权限受限的私有临时目录中解析副本。SQLite 仅打开副本，使用 `readOnly`、`query_only`、`trusted_schema=OFF` 和固定参数化查询；临时目录随后清理。它不改动业务 listen/已读游标或控制状态。node/store/worker JSON 以完整文件读入后立即按字段白名单投影，私钥、worker token、SSH transport 和原生服务配置不会进入页面、API或导出；不会另行读取原生服务凭据文件。主 DB/WAL 单文件上限各 512 MiB，JSON 上限 64 MiB；超限明确显示读取受限。活跃 rollback journal 或持续变化的复制会有界重试后标记暂不可读，保留旧画面。

每 750 毫秒检查已登记来源；数据库事件与控制回执分别读取，因此晚到回执无需新增消息也能显示。未变化 DB/WAL 使用可丢弃内存缓存；没有新的权威数据库。SSE 使用查看器独立的有限事件序列，断线时续读；数据库替换或续读范围过期时明确重新同步。查看器进程重启后访问 token 会改变，需打开新打印的链接，重新授权本地浏览器后读取新快照。来源内事件回退/首行改写也使历史页游标失效，要求重新加载。

默认回环地址、随机访问链接、Host/Origin 校验、无跨域许可和 CSP 限制共同约束本地入口。它面向当前用户授权的本机来源，不提供多用户身份与公网部署方案。导出含选定消息正文和原生 session ID，请按项目的数据范围使用。

## 验证与后续范围

```bash
npm test
npm run test:package
# 新建独立合成来源，复现 10k 消息、WAL、回执更新与只读验收。
# 每次使用新的目录名，保留先前结果。
node scripts/viewer-verify.mjs viewer-20261018-v99

# 在本机使用合成 state 和 fake SSH 执行真实 export CLI；不联系真实服务器。
node scripts/ssh-observer-verify.mjs ssh-observer-20261018-v99
```

`tests/viewer-*` 覆盖只读、关联、冲突、错误来源、查询边界、续读、分页和导出。`verification/viewer-*` 保存脱敏性能/回放结果；真实模型旧账本回放与新模型运行明确区分。代码索引为 `lib/viewer/readers/`、`projection.mjs`、`stream.mjs`、`server.mjs`、`cli.mjs` 和 `web/viewer/`。

当前开发分支可聚合显式登记的**本机目录和限定 room 的 SSH 来源**。SSH 观察的本机 fake-SSH 验收已覆盖真实导出 CLI、混合来源、身份与作用域拒绝、断连恢复、晚到回执、源替换和源文件内容不变；没有连接第二台真实机器，不替代真实双机通信或真实远端观察验收。后续再处理明确允许节点/room 的真机验收和可选 VPS 的认证与持久在线入口。Codex 内部 sub-agent 工具对话、原 harness 未交换到 room 的总结和任意桌面窗口都不会自动出现在本页面。

首版交付验证：实现提交 `d996db0` 的 [四平台组合 CI](https://github.com/IDLE-Cloud/agent-dialogue/actions/runs/39089715479) 全部通过，包括185项测试、独立全局prefix安装、网页资源/API和pinned hcom安装校验。合成性能与浏览器截图见仓库 `verification/viewer-20261018-v4/`、`verification/viewer-browser-20261018/`；旧真实模型账本的只读回放见 `verification/viewer-owned-20261018-v3/`，不是本轮新模型实验。
