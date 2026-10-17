# Changelog

## 0.2.0

- Extract the local communication prototype into a standalone GitHub-installable CLI.
- Store communication spaces and pinned dependency caches in user directories, independently of the package installation.
- Select pinned hcom 0.7.30 assets for macOS arm64/x64 and GNU Linux arm64/x64, with SHA-256 verification.
- Support selecting a local OpenCode service credential file without copying credentials into tool state.
- Preserve exact existing-chat bindings, collaboration rooms, receiver checks, reply references and uncertain-submission reconciliation.
- Include offline unit tests and an isolated npm package installation smoke test.

The existing-chat adapter was exercised with OpenCode 2.0.20 on macOS arm64. Native Windows and cross-machine room routing remain future work. The GitHub package is separate from publication to the npm registry.
