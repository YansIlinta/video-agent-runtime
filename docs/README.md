# Video Agent Runtime Documentation

This directory contains the technical documentation for the runtime as it exists today. The repository root [README](../README.md) is the product entry point; this index is for architecture, provider behavior, validation, mobile implementation and release history.

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the product and run it | [../README.md](../README.md) |
| Contribute code or documentation | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| Report or review a security-sensitive issue | [../SECURITY.md](../SECURITY.md) and [security.md](security.md) |
| Set up a development environment | [development.md](development.md) |
| Understand product wording and claim boundaries | [product-positioning.md](product-positioning.md) |
| Understand the core architecture | [architecture.md](architecture.md) |
| Connect an agent through MCP | [speech-mcp.md](speech-mcp.md) and [`../mcp.example.json`](../mcp.example.json) |
| Configure or compare speech models | [speech-models-2026.md](speech-models-2026.md) |
| Understand VoiceProfile / cloning / design | [voice-identity.md](voice-identity.md) |
| Run real ASR / LLM / TTS acceptance | [real-speech-acceptance.md](real-speech-acceptance.md) |
| Understand the mobile host | [mobile/README.md](mobile/README.md) |
| Check what has actually been measured | [benchmarks.md](benchmarks.md) |

## Core runtime

| Document | Contents |
| --- | --- |
| [product-positioning.md](product-positioning.md) | Canonical product wording, public terminology, non-goals and verification/claim levels |
| [development.md](development.md) | Local setup, provider configuration, commands, package boundaries, performance rules and testing strategy |
| [architecture.md](architecture.md) | Package boundaries, `source → Version → export`, ProjectStore layout, workflow, EditPlan/EditPatch, jobs, rendering and recovery |
| [security.md](security.md) | Secret policy, path/media boundaries, filtered outputs, voice-reference handling and agent restrictions |
| [control-api.md](control-api.md) | Narrow bearer-authenticated local HTTP control surface |
| [upstream-study.md](upstream-study.md) | Prior art and external projects that informed the architecture |

The central rule across these documents is that models propose structured changes while the runtime owns project state, validation, persistence and rendering.

## Speech & voice

| Document | Contents |
| --- | --- |
| [speech-models-2026.md](speech-models-2026.md) | Current ASR/TTS/voice model landscape, deployment modes and licensing notes |
| [voice-identity.md](voice-identity.md) | VoiceProfile, authorization, reference quality, Voice Design, cloning, deletion and provenance |
| [speech-mcp.md](speech-mcp.md) | Lightweight ASR → structured LLM → TTS MCP path and how it differs from the full editing runtime |
| [real-speech-acceptance.md](real-speech-acceptance.md) | Opt-in real-provider/model acceptance harness, metrics and claim boundaries |

### Current runtime choices

The repository currently has maintained runtime paths for:

- ASR: faster-whisper, Qwen3-ASR and hosted OpenAI transcription.
- Alignment/diarization: optional WhisperX enrichment.
- TTS: Kokoro, Qwen3-TTS and hosted OpenAI speech.
- Voice identity: authorized Qwen3-TTS cloning/design through the shared VoiceProvider contract.
- Structured LLM generation: schema-constrained provider contracts reused by editing and lightweight speech transforms.

The model catalog contains more candidates than the runtime intentionally implements. A model being researched does not mean it is a supported provider.

## Validation & measurements

| Document / command | Purpose |
| --- | --- |
| [benchmarks.md](benchmarks.md) | Recorded measurements and explicit unmeasured quantities |
| [real-speech-acceptance.md](real-speech-acceptance.md) | How to run real ASR / LLM / TTS / authorized clone acceptance |
| `npm run eval:speech-real` | Produce one real-provider acceptance report |
| `npm run benchmark:speech-summary` | Aggregate repeated real-provider reports by stage/provider/model |
| `npm run eval` | Deterministic semantic evaluation corpus |
| `npm run demo` | End-to-end local editing workflow with real FFmpeg rendering |

Measurement rules:

- A skipped check is written as skipped, never implied to have passed.
- CI does not claim local-model quality, hosted-provider behavior, VRAM, battery or device performance when the required runtime is absent.
- Controller RSS is not presented as child model-process memory.
- Machine-level `nvidia-smi` sampling is not presented as process-attributed peak VRAM.
- Invalid or blocked real-provider runs are retained as evidence instead of being removed from summaries.

## Mobile host

| Document | Contents |
| --- | --- |
| [mobile/README.md](mobile/README.md) | Mobile work entry point |
| [mobile/architecture.md](mobile/architecture.md) | Portability audit and host/platform boundaries |
| [mobile/native-host-status.md](mobile/native-host-status.md) | **Current native iOS/Android status and what is still unproven** |
| [mobile/known-issues.md](mobile/known-issues.md) | Open source-review defects ranked by severity |
| [mobile/framework-evaluation.md](mobile/framework-evaluation.md) | React Native New Architecture decision record |
| [mobile/provider-auth.md](mobile/provider-auth.md) | On-device BYOK and credential handling |
| [mobile/local-models.md](mobile/local-models.md) | On-device ASR/TTS research and milestone order |
| [mobile/migration.md](mobile/migration.md) | Host portability and project migration notes |

The mobile implementation must not be described as device-ready until native compilation, simulator/device media tests and the documented measurement pass exist.

## Open-source project entry points

| File | Purpose |
| --- | --- |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Contribution scope, architecture guardrails, test expectations and PR guidance |
| [../SECURITY.md](../SECURITY.md) | Security reporting and sensitive-data boundaries |
| [../AGENTS.md](../AGENTS.md) | Repository rules for Claude Code, Codex and other coding agents |
| [../.github/pull_request_template.md](../.github/pull_request_template.md) | Verification, performance, security and claim-boundary checklist for pull requests |

## Release history

Version-stamped reports live in [`releases/`](releases/). Everything else describes the current system.

| Release | Report |
| --- | --- |
| 0.4.0 | [mobile/native-host-status.md](mobile/native-host-status.md) |
| 0.3.0 | [releases/v0.3.0.md](releases/v0.3.0.md) |
| 0.2.0 | [releases/v0.2.0.md](releases/v0.2.0.md) |
| 0.1.5 | [releases/v0.1.5.md](releases/v0.1.5.md) · [audit](releases/v0.1.5-audit.md) |

A condensed release history is maintained in [../CHANGELOG.md](../CHANGELOG.md).

## Documentation conventions

- Root README = product home and quickest path to a working run.
- `CONTRIBUTING.md` = public contribution contract.
- `SECURITY.md` = public security-reporting entry point.
- `AGENTS.md` = coding-agent repository guardrails.
- `docs/development.md` = day-to-day setup and engineering commands.
- `docs/` = current technical truth.
- `docs/releases/` = version-stamped historical evidence.
- Provider capability tables describe the adapter that actually exists, not every feature an upstream model may advertise.
- Unsupported or unverified behavior is stated explicitly rather than hidden behind broad terms such as “mobile ready” or “fully local”.
