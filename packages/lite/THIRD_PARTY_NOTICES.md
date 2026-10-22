# Reuse and references

This package reuses this repository's standalone OpenCode protocol clients and MCP stdio transport from commit `f576ecba35c1819ff0fb96278e51ea92541ba772`. See `lib/native/PROVENANCE.md` and the comment in `lib/mcp-stdio.mjs`. The original bridge, local ledger, worker, migration and recovery implementation is not imported.

The mailbox/project/reply model was informed by MCP Agent Mail, Relaycast and hcom in the project's earlier design research. No source from these external projects or their runtimes is included in Lite. Runtime dependencies are Node.js built-ins only. This repository's existing `UNLICENSED` status also applies to this development package; public source availability does not grant an open-source license.
