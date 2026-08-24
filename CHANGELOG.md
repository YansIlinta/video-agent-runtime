# Changelog

Every release extends the previous runtime rather than replacing it. `ProjectStore`, `VideoAgentCore`, Workflow, Transcript, EditingStrategy, EditPlan/EditPatch, Timeline, Version, Job/Event, ProviderCall, the CLI/MCP adapters and the FFmpeg renderer have been authoritative since 0.1.0 and remain so. No release has introduced a second timeline, a parallel persistence system, or a surface-specific editing model.

## 0.4.0 — Native mobile host prototype

React Native New Architecture shell sources, a Codegen TurboModule contract, a shared `createMobileHost()` composition root, a durable mobile `ProjectRepository`, native Swift and Kotlin adapter sources, a capability-gated native renderer, secure BYOK settings, ContextPack privacy accounting, network destination auditing and restart-recovery tests.

Core changes: portable ASR normalization, cache keys, speech persistence, voice analysis, fusion and duration-fit services were separated from the Node providers; core edit helpers no longer import `node:crypto`; preview self-check became injectable; `Renderer` gained a truthful optional capability contract.

**Not done:** neither native target was compiled or run. No device evidence exists.
Status → [docs/mobile/native-host-status.md](docs/mobile/native-host-status.md) · Open defects → [docs/mobile/known-issues.md](docs/mobile/known-issues.md)

## 0.3.0 — Mobile Host architecture

A concrete zero-server Mobile Host foundation rather than a documentation-only proposal. Explicit host contracts for filesystem, secure storage, HTTP, background execution, clock, ID, crypto, permissions, capabilities and resource budgets. `node-local` adapters and a `mobile-simulation` host profile. A domain `ProjectRepository` alongside the existing Node `ProjectStore`. Additive `AssetRef`, `ProviderConfig`, `RemoteContextPolicy` and `ContextPack` schemas. A provider registry with secure credential lookup and API model discovery. A zero-server simulation completing an end-to-end edit without starting the optional network API.

Report → [docs/releases/v0.3.0.md](docs/releases/v0.3.0.md)

## 0.2.0 — Voice identity infrastructure

Authorized VoiceProfile enrollment covering preset, designed, cloned and imported voices. Provider-neutral `VoiceCapabilities`. Cached, ranked reference analysis that never auto-enrolls a detected speaker. Description-driven voice design as a first-class workflow rather than a disguised clone. `SpeechAsset` provenance. Deterministic duration fitting with explicit classification. Speech correction through typed EditPatch operations. Multilingual dubbing as linked timeline tracks. Secure deletion, durable voice jobs, an expanded MCP surface and a narrow authenticated control API.

Report → [docs/releases/v0.2.0.md](docs/releases/v0.2.0.md)

## 0.1.5 — Productionization

`OpenAILLMProvider` implementing vendor-neutral structured generation over the Responses API, with independent Zod validation, targeted repair retries, bounded transient retries, cancellation, health checks and persisted call provenance. First-class EditPatch validation/diff/apply. Optional WhisperX alignment and diarization with deterministic Transcript fusion. On-demand FFmpeg shot and keyframe evidence. Durable local jobs with progress, classified retries, idempotency, cancellation, recovery and quotas. Golden semantic evaluations.

Report → [docs/releases/v0.1.5.md](docs/releases/v0.1.5.md) · Pre-release audit → [docs/releases/v0.1.5-audit.md](docs/releases/v0.1.5-audit.md)

## 0.1.0 — Initial runtime

The approval-gated editing workflow: source media → Asset → Transcript → approved EditingStrategy → EditPlan → validated Timeline → immutable Version → preview → Feedback → Diagnosis → final approval → export. CLI and MCP adapters over a shared core, and an FFmpeg renderer that receives argument arrays rather than agent-authored shell strings.
