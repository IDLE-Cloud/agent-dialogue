# Protocol client provenance

`opencode.mjs` and `opencode-v1.mjs` are standalone protocol clients copied from this repository's `lib/` at commit `f576ecba35c1819ff0fb96278e51ea92541ba772` (2026-10-22). Their only dependencies are Node.js built-ins. Lite imports no original bridge, store, worker, recovery, or private-file implementation.

Lite's V2 copy additionally rejects a service descriptor version change during session revalidation, alongside its existing ID/origin checks. The original root client is unchanged.

The OpenCode V1 protocol client remains pinned to 1.19.0. The OpenCode V2 readiness wrapper in `../adapters.mjs` uses the 2.0.20 service's documented `/api/session/active`, session permission and pending form endpoints, checked against the running local service's OpenAPI document on 2026-10-22. No credential or private conversation content was copied into this package.
