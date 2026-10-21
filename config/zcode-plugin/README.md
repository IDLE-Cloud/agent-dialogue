# Agent Dialogue ZCode plugin template

This local marketplace packages five Agent Dialogue MCP tools, a `/dialogue` command, a usage skill, and optional exact-chat `SessionStart` guidance. Follow [the ZCode guide](../../docs/ZCODE.md) for bootstrap and operation.

The setup sequence is: initialize a private `zcode` service for the exact project directory, configure MCP with that descriptor and a reserved private context path, call `dialogue_identity` in the intended native chat, have the operator select its full session ID and create its room, then export scope with `mcp-context --output` and read context/inbox in the original chat.

Install this existing directory or `marketplace.json` through ZCode Settings → Plugins → Create → Add Plugin Marketplace. Configure the absolute Node executable, Agent Dialogue installation, communication state, service descriptor and private context path. The context path may initially be absent; only identity registration is available before scope exists. The template contains no machine-specific identity or secret.

The MCP entry is `node /ABS/app/bin/agent-dialogue.mjs mcp --zcode-service /ABS/private/zcode-service.json --context /ABS/private/mcp-context.json`. Host metadata must identify the same native chat; workspace scope and model arguments are not identity proof. Model arguments cannot supply a different sessionId.

The optional hook is synchronous and read-only. It uses `AGENT_DIALOGUE_ZCODE_CONTEXT`, or `agent-dialogue-context.json` under `ZCODE_PLUGIN_DATA`; only an exact `session_id` and `cwd` match receives usage guidance. It requires `node` on PATH. Missing or mismatched context produces no model-visible output. It does not send, poll, change permissions or wake a chat. Inbox receipt is `tool-read`, not native prompt admission.

The marketplace entry version and `.zcode-plugin/plugin.json` version must remain equal when publishing an update. This is a local/Git marketplace template, not a claim of admission to ZCode's official public store.

The template declares `protocolVersion: "legacy"` for the tools JSON-RPC entry. In pinned ZCode 3.14.3, however, the plugin stdio resolver does not copy that field into the runtime config. Do not assume the declaration forces runtime mode; use the guide's manual native workspace `mcp.servers` configuration for the initial protocol-sensitive acceptance, and verify plugin connection separately. UI complete-config import uses `mcpServers`; it is not the top-level shape of a native `.zcode/config.json` file.
