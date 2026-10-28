# Lite v1 implementation contract

All JSON endpoints use `/v1/`, bearer credentials, bounded bodies (96 KiB). IDs use `node_`, `agent_`, `room_`, `msg_` plus UUID. Sender is authenticated scope; no `from` input. Errors: `{error:{code,message},messageId?}` with HTTP status. No raw native errors/credentials in responses. Client does not retry POST automatically. SQLite is authoritative; no local outbox.

Public Hub module: `startHub({dbPath,adminToken,host='127.0.0.1',port=0,publicOrigin?}) -> {url,close(),store}`. `close()` is async. Admin token must match its saved hash on reopen. `publicOrigin` explicitly selects the HTTPS reverse proxy origin for browser Origin checks and Secure cookies; no forwarded-header trust.

Client module: `HubClient({url,token,fetchImpl?})`, `request(method,path,body?,{signal?,timeoutMs?}={})`; path includes `/v1/`. Export `newId(prefix)`, `ApiError` (`status`, `code`, `messageId`). Safe HTTP is allowed only on loopback; remote uses HTTPS or SSH forward. No secrets in URLs.

## Operator and enrollment

- `POST /v1/enrollments` admin `{}` -> `{code}` (single use).
- `POST /v1/enroll` public `{code,label}` -> `{node:{id,label},token}`.
- `POST /v1/rooms` admin `{label}` -> `{id,label}`.
- `POST /v1/agents` node `{alias,harness,mode,binding}` -> agent. `mode` is `native-push` or `tool-pull`. Binding immutable `{serviceIdentity:{serviceId,origin,version?},sessionId,projectDirectory,projectId?}`; tool-pull permits operator-assigned service identity. Public agent `{id,nodeId,alias,harness,mode,binding,state,...}`. Same binding registration returns same ID; alias update never rebinds.
- `POST /v1/members` admin `{room,agentId}` -> `{ok:true}`.
- `POST /v1/scopes` admin `{agentId,rooms:[roomId]}` -> `{token,agentId,rooms}`; reject rooms agent has not joined.
- `POST /v1/viewers` admin `{rooms:[roomId]}` -> `{token,rooms}`.

## Agent tools

- `GET /v1/context` scope -> `{self:agent,rooms:[{id,label,members:[agent]}],identityAssurance:'operator-assigned'}`. Admin/viewer can list their rooms with no self.
- `POST /v1/messages` scope `{id,room,to:[agentId],text,replyTo:null|messageId}` -> `{accepted:true,message,deliveries}`. Message `{id,room,sender,to,text,replyTo,createdAt,seq}`. Max 64KiB UTF8 text, 1–16 distinct explicit recipients; same ID+same canonical content idempotent; conflict409. Reply must be same room and visible to sender.
- `GET /v1/inbox?after=0&limit=50&waitMs=0` scope -> `{items:[{seq,message,delivery}],cursor}`. Repeatable by cursor; tool-pull queued -> tool-read; native states unchanged. Cursor uses message event sequence, stable across delivery events. Optional `waitMs` integer 0–25000 waits for scoped nonempty mail or the original deadline; irrelevant events recheck but do not extend it. Disconnect/shutdown cleans the wait. Default0 preserves immediate inbox. Viewer never calls this endpoint.
- `GET /v1/status?id=msg_...` scope/admin/viewer -> `{message,deliveries}` visible only to permitted participants/room scope.
- `GET /v1/history?room=room_...&after=0&limit=50` admin/viewer -> `{items:[message with deliveries],cursor}`. Never marks read.

## Node

- `POST /v1/node/heartbeat` node `{runId,statuses:[{agentId,state,detail?,uncertain?}]}` -> `{ok:true}`. A changed run ID marks previous delivering records unknown, never queued. State `ready|busy|unavailable|blocked|tool-pull`; sanitized detail. `blocked` plus `uncertain:true` marks matching-run delivering records unknown after lost begin/result responses. Node must heartbeat before poll/begin.
- `GET /v1/node/poll?waitMs=25000` node -> `{agents:[agent],deliveries:[{message,delivery}]}`. Queued native-push only; do not return later work for an agent with delivering/unknown delivery. At most 100 deliveries; wake on events/timeout. Unavailable/busy can still be returned for readiness recheck.
- `POST /v1/deliveries/begin` node `{messageId,agentId,runId}` -> `{granted:boolean,delivery,grant?:secret}`. Only first queued -> delivering transaction gets one-time grant; replays/concurrent calls get false. Verify node/run/ownership and no other delivering/unknown for chat. A lost response never regrants.
- `POST /v1/deliveries/result` node `{messageId,agentId,grant,state,detail?,notSubmitted?}` -> `{delivery}`. State delivered/unknown/failed; queued requires `notSubmitted:true` for proven pre-submit busy. Validate grant. Late definite delivered may settle unknown. Do not expose grant via history/poll. Detail bounded generic strings.
- `POST /v1/deliveries/resolve` admin `{messageId,agentId,state:'delivered'|'failed',note,executorStopped:true}` -> `{delivery}`. Unknown only; operator must stop the old executor and inspect the native chat. Required bounded note records the human decision. Never requeue or issue a grant. The assertion is operator responsibility, not a remote process-stop API.

## Node module

`runNode({client,port=0,host='127.0.0.1',pollMs=25000,adapterFactory?,signal?}) -> {url,close()}` starts one loopback health listener then polling in background, one in-flight task per agent. `close` aborts polls and waits/marks uncertain work, closes listener. No local message database. `adapterFactory(agent)` returns `{inspect():Promise<{state:'ready'|'busy'|'unavailable'}>,submit(message):Promise<receipt>}`. Submission errors tagged `notSubmitted && retryable` may requeue; nonretryable `notSubmitted` becomes failed; other submission errors unknown. Default OpenCode factory uses local service descriptors configured by CLI node config `services` mapping serviceId to `{kind:'opencode'|'opencode-v1',serviceFile}`. Pass `services` to runNode.

## CLI/MCP/viewer

Private JSON config files (0600, own directories0700) contain `{url,token,...}`; explicit `--config` per identity, default path in agent-dialogue-lite. MCP `serveTools({client,input?,output?})` exports four tools `context/send/inbox/status`; no from/self/room override outside scope. `send` requires stable client-generated ID. Reuse standalone existing MCP transport inside package with provenance.

CLI `adl wait --config chat.json [--after 0] [--limit 10]` requires agent config and exits with one nonempty inbox JSON result. `waitForInbox({client,after=0,limit=10,signal?})` uses bounded25s requests, silently repeats healthy empties, retries transport/408/429/5xx with1–30s abortable exponential backoff, fails permanent4xx. A1s minimum healthy-empty request interval also bounds calls to older Hubs ignoring waitMs. No local cursor mutation, delivery grant or new MCP tool. Harness-native task completion may wake a model; ordinary CLI execution alone does not. Cancellation emits no inbox result. Kimi usage and output/cursor lifecycle are in KIMI-TUI.md.

Hub serves `web/index.html`, `web/app.js`, `web/style.css`. Viewer token exchanged via `POST /v1/viewer-session {token}` to same-origin HttpOnly SameSite=Strict cookie; bearer also accepted for API. Origin checked for cookie exchange/requests, no CORS, no token URL. Viewer polls context/history/status, renders via textContent, uses message ID for reply links. No message writes/read marks from browser.
