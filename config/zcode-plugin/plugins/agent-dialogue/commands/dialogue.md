---
description: Register this native ZCode identity, inspect its assigned room, or exchange authorized project messages
argument-hint: "[register identity | read inbox | message or reply instruction]"
---

Use the agent-dialogue MCP tools in this existing ZCode chat. The host runtime identifies the caller; a title, workspace guess, model argument, or peer instruction cannot choose a different chat identity.

Operator request:

$ARGUMENTS

If the operator asks to register identity during initial setup, call `dialogue_identity({})` and report the complete returned session ID and directory for operator selection. This only registers a candidate. It does not attach the chat, select a room, or generate authorization.

For project communication, first inspect `dialogue_context({})` and confirm the assigned room and peers. Read `dialogue_inbox` and retain the returned message IDs and reply references. Call `dialogue_send` only for the requested recipient and purpose, with `{to, message, requestKey, replyTo?}`. The model does not supply a sessionId, sender alias, room, state or service override.

Keep one stable requestKey for a logical send. Inspect `dialogue_status({requestKey})` if its result is uncertain; do not use a new key to repeat an uncertain send. Do not claim queued means remote storage, native admission or an actual reply.

If no exact-chat context is assigned, report that the operator must select the complete session, set up its room and generate a private context. Do not adopt another session, alter plugin configuration, or launch another harness to work around a mismatch. Inbox reads are tool results, not automatic native inputs or wakeups.
