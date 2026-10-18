# Changelog

## 0.3.0 (development)

- Add packaged operator and agent guides, a portable project rules snippet, and read-only `agent-guide --room ID --from ALIAS [--to ALIAS]` contexts with owning-node checks, exact peer sessions and quoted queue commands.
- Add explicit SSH observer configuration and a fixed read-only export entry. Verify node and sealed-room pins, nonce and wire signatures at both ends; collect bounded room snapshots asynchronously and retain stale history across disconnects.
- Add a loopback-only read-only browser viewer for explicit local sources, exact session identities, protocol-linked replies, queue/result folding, signed wire-copy deduplication and delivery evidence.
- Read stable DB/WAL byte snapshots through SQLite only in private temporary copies; leave communication DB/WAL/SHM, stores, worker cursors and lifecycle untouched. Observe late receipts separately from new events.
- Add filtered history paging, bounded SSE replay/reset, selected-room JSON/Markdown export and source availability diagnostics. Serve plain message text with local access tokens, Host/Origin checks and restrictive CSP.
- Package the viewer's static assets and installation smoke check; require Node >=22.13 for built-in SQLite without a startup flag.
- Add native adapter contracts and an exact Codex shared-daemon client using its existing Unix WebSocket and durable input queue. Resume is explicit and execution starts only bridge-owned queued inputs.
- Add Ed25519 node identities, signed public binding cards, pinned peers and owner-signed room manifests accepted on each node.
- Add fixed SSH stdio and local-process test transports, signed global message/reply IDs, sender/receiver routing checks, ledger reconciliation and duplicate receipt recovery.
- Keep message bodies in local hcom ledgers; store only routing hashes, IDs and state in inbox/outbox metadata.
- Add local-only `collab send --queue` for network-restricted model shells. The owning background worker revalidates bindings and performs network delivery; queued/forwarded/remote-stored receipts remain distinct.
- Preserve prior remote-stored evidence after a failed retry, accept legal aliases without inherited-object collisions, and reject oversized encoded ledger frames before saving intents.
- Verify two independent local nodes with actual free OpenCode model tool calls and preserved pre-attachment project context. Real two-host SSH is recorded separately below.
- 2026-10-18: pass [40/40 real two-host assertions](verification/vps-integration-20261018-v5/metrics.json) between an owned macOS arm64 Codex CLI 0.162.1 validation server and Debian 13 x64 VPS OpenCode 2.0.20 with an explicitly verified zero-price model. Verify four signed global messages, bidirectional model-origin requests/replies, preserved pre-attachment context, a real JSON artifact, replay/rejection guards and quiescent state hashes. This does not establish attachment to the current active Codex Desktop chat.
- 2026-10-18: pass [11/11 independent SSH observer assertions](verification/vps-observer-20261018-v1/metrics.json), with two allowed real SSH collections and two observer-only client gate rejections, retained stale history, fresh recovery, unchanged logical message IDs and unchanged local/remote state bytes. The gate is a controlled client transport failure, not a VPS or public-network outage; no model or native harness API is called. Persistent Codex leases belong to the acceptance helper, not automatic production thread resume or process restart.

## 0.2.0

- Extract the local communication prototype into a standalone GitHub-installable CLI.
- Store communication spaces and pinned dependency caches in user directories, independently of the package installation.
- Select pinned hcom 0.7.30 assets for macOS arm64/x64 and GNU Linux arm64/x64, with SHA-256 verification.
- Support selecting a local OpenCode service credential file without copying credentials into tool state.
- Preserve exact existing-chat bindings, collaboration rooms, receiver checks, reply references and uncertain-submission reconciliation.
- Include offline unit tests and an isolated npm package installation smoke test.

The existing-chat adapter was exercised with OpenCode 2.0.20 on macOS arm64. Native Windows and cross-machine room routing remain future work. The GitHub package is separate from publication to the npm registry.
