# Real-host acceptance runner

`scripts/vps-integration.mjs` is an opt-in development verifier for a local Codex thread and an OpenCode chat on a second Linux/macOS host. It has no default host, SSH route, model or Codex thread. The first public template is [`config/vps-integration.example.json`](../config/vps-integration.example.json); every placeholder must be replaced in a private copy.

The controller and target must already have matching communication code, Node.js 22.13+, the pinned hcom runtime, and authenticated SSH routes in both directions. The controller does not install software, change SSH configuration, start OpenCode, accept unknown host keys or copy model credentials. Each side uses a distinct isolated state directory and node key. OpenCode listens on the target's loopback interface and reads its own local service credential file.

A target behind NAT can use a separately owned reverse SSH tunnel. Keep its listening address on the VPS loopback interface. The target-to-controller key can be restricted to a forced command for this test's exact `node receive` route; general controller shell access is unnecessary. The controller's separate SSH route must allow the fixed remote helper and read-only `view-export` command. A private `ssh` wrapper in each configured PATH can select the test's own `-F` file without editing global SSH settings.

Copy `scripts/vps-remote-helper.mjs` as one file to the configured remote `helper` path. It locates `lib/opencode.mjs` relative to the configured real JavaScript CLI entry, so it works with a normal installed package as well as a checkout. The helper is an SSH stdio program; do not expose it as an HTTP service or give it to a model as an execution tool.

```sh
node scripts/vps-integration.mjs --help
node scripts/vps-integration.mjs --config /absolute/private/vps-test.json
```

Configuration requirements:

- `runId` is a real calendar date plus a fresh positive version, for example `vps-integration-20990101-v1`. The example is synthetic. `outputDir` and `privateDir` must each end with that run ID and must be new, separate directories. Existing results, empty directories and symbolic links are not reused. The private configuration itself belongs outside these two fresh directories.
- All executable, CLI, credential-file, socket and state paths are explicit absolute paths. Node paths should come from `node -p process.execPath`; CLI paths should be the installed real JavaScript entry. The remote helper imports from that package root.
- `local.codexThread` is the complete ID of an owned test thread. `local.codexCwd` must exactly match its native working directory, and `local.stateDir` must be a dedicated directory inside that workspace that the existing sandbox already permits writing. The runner keeps the current model and approval settings. It refuses busy threads and existing queued work.
- Both state directories must be fresh or empty. Each initialized space, seeded chat, node identity and room belongs to that run. A failed run's state and model chat are retained for diagnosis; use a new run ID and new state paths for another run.
- `path` is an explicit search path with only absolute entries. Include each side's private SSH wrapper and required system tools. The OpenCode service itself must use the intended target PATH so its one-shot shell commands reach the same private SSH route.
- `model` selects an exact provider/model. Both controller and target recheck that it is enabled and every advertised input, output, cache-read and cache-write tier is zero. A familiar name or an earlier run does not substitute for that check. No fallback to a priced model is attempted.

The runner first saves different project facts in the two normal native chats, then attaches those exact chats, exchanges signed public cards and imports one sealed room. Codex submits a local queued question; its owning worker uses SSH to deliver it to the VPS. OpenCode sends one globally linked reply. Codex writes a new nonce-named decision JSON inside its owned workspace; the controller reads the actual file and verifies both previously separated facts. A second exchange reverses the initiating harness. The verifier checks native tool execution and receipts, not only assistant text.

OpenCode gets at most two one-time shell approvals. Each command must match the precise environment, Node/CLI paths, room, sender, destination, native session, queue mode and global reply ID. It must include this run's marker. Operators, command substitution, extra flags, extra commands and unrelated environment values are rejected. No saved harness permission is changed, and no Codex approval request is granted.

After the model exchange, the verifier repeats the original global message ID over real SSH and checks that its original remote event/native input is reused. A signed body collision, altered signature, unaccepted room and wrong expected session must be rejected without adding a message, submission or native input. It checks both native sessions and the Codex model/permission settings again.

Finally, it detaches the owned bridge workers, waits for those workers to stop, and collects a real SSH snapshot for the exact node and room pins. The local viewer must merge the four formal message copies and preserve their global reply links and native admission evidence. Before/after hashes cover the quiescent local and remote state files, including any DB/WAL/SHM files. This phase does not create a remote viewer or call a model. Controlled transport disconnection and recovery are a separate acceptance step until a dedicated test route gate is configured and verified; a successful full snapshot does not establish network-fault recovery.

Public `metrics.json` contains sanitized assertions, versions, source hashes, counts, timing and an artifact hash. Native chat IDs, host aliases, local paths, prompts, transcripts and error detail remain in a private 0600 diagnosis file. Never publish the private configuration or diagnosis. The runner preserves native chats and the private decision artifact. On failure it aborts only its owned VPS session, interrupts an identified owned Codex turn when appropriate, detaches its own bindings and closes its own reader/viewer; it does not stop the shared OpenCode service, SSH daemon, tunnel or unrelated user process.

For software installation, the pinned OpenCode V2 package, loopback service setup, explicit PATH, receiver-only SSH routes and viewer scope, see the reusable [VPS deployment prerequisites](VPS-DEPLOYMENT.md). Deployment alone is not a successful real-host acceptance result.

## Independent controlled observation recovery

After the owned communication workers have stopped, run the separate model-free verifier with explicitly selected existing state and pins:

```sh
node scripts/vps-observer-integration.mjs --help
node scripts/vps-observer-integration.mjs --config /absolute/private/observer.json
```

Use [`config/vps-observer.example.json`](../config/vps-observer.example.json) as a synthetic template. The observer run has its own fresh `vps-observer-YYYYMMDD-vN` public/private directories. Evidence directories must be separate from each other and from the selected local source, including through ancestor symbolic links. It does not derive a host, room or identity from another run's private diagnosis. Copy the actual selected node ID and each sealed room's full ID, revision and manifest hash into the private configuration.

The verifier creates a private `ssh` executable only in its own process PATH. That shim matches the exact production `view-export` invocation and validates its complete nonce/node/room request. While open it forwards the original stdin bytes to the explicitly selected real SSH executable with the private `-F` configuration. While closed it returns an SSH-style failure without starting the lower SSH process. Other SSH invocations, including bridge `node receive`, pass through; other processes never inherit this temporary PATH. Gate updates do not change a network interface, firewall, SSH daemon, tunnel or global SSH configuration.

Acceptance proceeds from an initial real scoped snapshot to at least two gated export failures. The source must become unavailable while retaining its last successful data and observation time. Reopening must obtain a new real SSH snapshot with fresh request identity, restore availability and preserve the logical message IDs. Gate audit entries contain only a canonical nonce, decision and timestamp. Public metrics distinguish this controlled client-side transport rejection from a network or VPS outage; it is not a claim that the underlying public network was disconnected.

Before and after the entire sequence, both state trees are hashed by one fixed program. Paths are supplied only through JSON stdin. That program uses bounded streaming `O_RDONLY | O_NOFOLLOW` reads, refuses symbolic links and concurrent per-file changes, and never opens SQLite or loads the communication runtime. Limits are 16 KiB request, 4,096 files, depth 32, 512 MiB per file, 1 GiB total bytes, 10-second internal work deadline and 1 MiB response; each controller hash process also has a 20-second deadline. Hash manifests and source observations stay in private diagnosis; public results contain counts, assertions and source/audit hashes. Any concurrent writer can invalidate this byte comparison, so stop the owned bridge workers before starting it.

The verifier calls no model or native harness API, changes no binding, and preserves both source trees. It closes only its own viewer/collector and leaves the private gate closed with its minimal audit log available for diagnosis. A failed run remains intact; use a new run ID for another attempt.

The selected observer SSH subprocess runs in its own owned POSIX process group. Gate cancellation sends termination to that group and escalates after 100 ms, before the production collector's 500 ms escalation can remove the shim. The fixed hash subprocesses use the same owned-group cleanup principle and bounded settlement, so a child retaining inherited descriptors cannot hold the controller open indefinitely. Synthetic cancellation tests include a lower SSH fixture and a grandchild that both ignore termination; they must both be gone before an outer forced stop. This cleanup applies only to processes started by the verifier.

## Native owner instructions and native command evidence

The fixture facts are synthetic, nonsecret and independently randomized. Each ordinary chat saves its own facts before attachment. After the signed room is accepted, the native owner supplies the exact room, sender, destination, expected native session and bounded communication command to each chat. That instruction authorizes sharing these specific fixture facts; an incoming peer frame cannot grant new tools or permissions. Routing flags remain mandatory even if a model changes its reply wording.

Codex native command evidence can contain an absolute system shell with exactly `-lc` and one literal command argument. Only the evidence reader may unwrap that exact form, then apply the same strict command matcher to its inner command. This does not expand OpenCode permission approval, evaluate shell text or accept extra shell arguments. A model's claimed execution still cannot replace native command status, queue receipt and worker/wire reconciliation.
