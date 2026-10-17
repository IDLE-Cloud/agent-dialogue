# Changelog

## 0.3.0 (development)

- Add native adapter contracts and an exact Codex shared-daemon client using its existing Unix WebSocket and durable input queue. Resume is explicit and execution starts only bridge-owned queued inputs.
- Add Ed25519 node identities, signed public binding cards, pinned peers and owner-signed room manifests accepted on each node.
- Add fixed SSH stdio and local-process test transports, signed global message/reply IDs, sender/receiver routing checks, ledger reconciliation and duplicate receipt recovery.
- Keep message bodies in local hcom ledgers; store only routing hashes, IDs and state in inbox/outbox metadata.
- Add local-only `collab send --queue` for network-restricted model shells. The owning background worker revalidates bindings and performs network delivery; queued/forwarded/remote-stored receipts remain distinct.
- Preserve prior remote-stored evidence after a failed retry, accept legal aliases without inherited-object collisions, and reject oversized encoded ledger frames before saving intents.
- Verify two independent local nodes with actual free OpenCode model tool calls and preserved pre-attachment project context. Real two-host SSH remains a separate pending acceptance check.

## 0.2.0

- Extract the local communication prototype into a standalone GitHub-installable CLI.
- Store communication spaces and pinned dependency caches in user directories, independently of the package installation.
- Select pinned hcom 0.7.30 assets for macOS arm64/x64 and GNU Linux arm64/x64, with SHA-256 verification.
- Support selecting a local OpenCode service credential file without copying credentials into tool state.
- Preserve exact existing-chat bindings, collaboration rooms, receiver checks, reply references and uncertain-submission reconciliation.
- Include offline unit tests and an isolated npm package installation smoke test.

The existing-chat adapter was exercised with OpenCode 2.0.20 on macOS arm64. Native Windows and cross-machine room routing remain future work. The GitHub package is separate from publication to the npm registry.
