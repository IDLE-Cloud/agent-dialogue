# Third-party components

## hcom

The tool invokes the unmodified hcom CLI. `agent-dialogue setup` downloads a pinned upstream release into the user's cache and checks its SHA-256 digest. No hcom binary or source is bundled in this package.

- Repository: https://github.com/aannoo/hcom
- Release: https://github.com/aannoo/hcom/releases/tag/v0.7.30
- Release commit: `7165097353099bb80f7544d91e5c0d4494134eb6`
- Asset URLs and SHA-256 values: `config/hcom.lock.json`
- Upstream license and notices apply to hcom: https://github.com/aannoo/hcom/blob/7165097353099bb80f7544d91e5c0d4494134eb6/LICENSE

## Harness integrations

The OpenCode adapter calls the existing local service API. The CLI launch path invokes the user's separately installed Codex, OpenCode, Kimi Code or Pi through hcom. These applications, their model credentials and their native chat data are not bundled.

OpenCode API reference: https://dev.opencode.ai/v2/docs/api . Compatibility is checked against the installed service contract; the currently exercised native version is 2.0.20.

## Project provenance

This standalone tool follows the local prototype in `IDLE-Cloud/Remote_Research`. The package contains the communication implementation and tests; it excludes research archives, native chat transcripts, private environment inventories and running state.
