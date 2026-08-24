# V3 Mobile Host Benchmarks

Run: 2026-08-24, Windows x64, Node v24.14.1, 100 iterations.

| Benchmark | Median | p95 | Max |
|---|---:|---:|---:|
| Zero-server Mobile Host simulation | 0.502 ms | 1.418 ms | 17.209 ms |

Every iteration created a project, imported a logical in-memory video asset, produced a deterministic local transcript, created a remote-text-only fake strategy/EditPlan, validated/applied it into Timeline/Version, and wrote a local preview artifact. `backendRequests` was `0` and final version was `1`.

Scope warning: this measures portable orchestration, schema validation, hashing and in-memory fixture storage/rendering on the development PC. It is not an AVFoundation/Media3 codec benchmark, local-model benchmark, battery test or real-device claim. The device plan is in `docs/mobile-local-models.md`.

Command: `npm run benchmark:mobile-host`.

