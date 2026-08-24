# Documentation

Documents are organized by topic. Version-stamped material lives in [`releases/`](releases/); everything outside it describes the system as it stands today.

## Design

| Document | Contents |
| --- | --- |
| [architecture.md](architecture.md) | Package layout, the `source → Version → export` flow, durable project layout, planner/patch/job/render design |
| [security.md](security.md) | Voice-reference handling, secret policy, what is filtered out of MCP and network responses |
| [control-api.md](control-api.md) | The narrow bearer-authenticated HTTP control surface and its endpoints |
| [voice-identity.md](voice-identity.md) | Empirical study of voice/TTS models and deployment options |

## Mobile

| Document | Contents |
| --- | --- |
| [mobile/README.md](mobile/README.md) | Entry point for the mobile host work |
| [mobile/architecture.md](mobile/architecture.md) | Mobile Host runtime audit: what had to become portable and why |
| [mobile/native-host-status.md](mobile/native-host-status.md) | **Current status of the native iOS/Android host, including what is not yet proven** |
| [mobile/known-issues.md](mobile/known-issues.md) | Open defects found by source review, ranked by severity |
| [mobile/framework-evaluation.md](mobile/framework-evaluation.md) | Why React Native New Architecture over the alternatives |
| [mobile/provider-auth.md](mobile/provider-auth.md) | Provider authentication on device; the BYOK decision record |
| [mobile/local-models.md](mobile/local-models.md) | On-device ASR/TTS evaluation and the milestone order |
| [mobile/migration.md](mobile/migration.md) | Porting an existing Node-host project to a new host |

## Measurements and research

| Document | Contents |
| --- | --- |
| [benchmarks.md](benchmarks.md) | All measured figures, plus an explicit list of what was **not** measured |
| [upstream-study.md](upstream-study.md) | Prior-art survey behind the runtime design |

## Release history

| Release | Report |
| --- | --- |
| 0.4.0 | [mobile/native-host-status.md](mobile/native-host-status.md) |
| 0.3.0 | [releases/v0.3.0.md](releases/v0.3.0.md) |
| 0.2.0 | [releases/v0.2.0.md](releases/v0.2.0.md) |
| 0.1.5 | [releases/v0.1.5.md](releases/v0.1.5.md) · [audit](releases/v0.1.5-audit.md) |

A condensed summary of every release is in [../CHANGELOG.md](../CHANGELOG.md).

## Conventions

- Reports state what was verified, on what host, and what was skipped. A skipped check is written as skipped, never omitted.
- Benchmark figures carry the environment they were measured on and a scope warning naming what they do not cover.
- Unmeasured quantities stay unmeasured. They are not filled with estimates.
