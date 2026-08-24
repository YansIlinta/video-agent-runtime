# Architecture

Video Agent Runtime is a headless editing service. The CLI and MCP server are thin adapters over the same `VideoAgentCore`; neither is allowed to mutate project JSON or invoke FFmpeg directly.

## Flow

`source media -> Asset -> Transcript -> approved EditingStrategy -> EditPlan -> validated Timeline -> immutable Version -> preview -> Feedback -> Diagnosis -> final approval -> export`

All timeline values are integer microseconds. Provider output is parsed through Zod schemas, then checked semantically before it can become a version. Project writes are atomic and retain a backup. A per-project lock prevents two mutations from racing.

## Packages

- `packages/core`: schemas, time math, storage, edit semantics, workflow, feedback diagnosis, compact timeline context.
- `packages/providers`: capability contracts, deterministic offline doubles, structured-output safeguards.
- `packages/speech`: faster-whisper and Kokoro sidecar adapters, transcript normalization, speech-duration fitting.
- `packages/media`: safe subprocess execution and ffprobe metadata extraction.
- `packages/render`: FFmpeg filter-graph compiler, preview/final profiles, audio mixing, captions, self-check.
- `packages/platform`: host contracts — filesystem, secure storage, HTTP, background execution, clock/ID/crypto, permissions, capabilities, resource budgets — plus the `node-local` adapters.
- `packages/runtime`: the application service and dependency assembly.
- `packages/mobile`: the portable mobile host — native adapters, project repository, provider settings, capability-gated renderer, ContextPack privacy accounting, composition root.
- `packages/mcp`: constrained MCP tools with structured results.
- `packages/api`: the narrow bearer-authenticated control server.
- `apps/cli`: equivalent local commands for humans and automation.
- `apps/mobile`: React Native shell sources, the Codegen TurboModule spec, and the Swift/Kotlin native host implementations.

## Durable project layout

Each project owns `project.json`, `workflow.json`, `timeline.json`, assets, transcripts, strategies, plans, feedback, diagnoses, immutable versions, previews, derived speech, exports, and logs. Derived artifacts record provider/model provenance. Raw, normalized, and display transcript text remain distinct.

## Speech

The default providers are deterministic and offline so the full workflow is reproducible in CI. `VIDEO_AGENT_ASR=faster-whisper` and `VIDEO_AGENT_TTS=kokoro` select optional Python sidecars. The core depends only on provider capabilities, so WhisperX alignment/diarization or hosted providers can be added without changing timeline semantics.

V1.5 adds optional WhisperX alignment and diarization as separate providers. A deterministic fusion layer maps aligned words and speaker intervals back into the canonical Transcript, records timing source (`asr`, `aligned`, or `estimated`), preserves raw ASR JSON, and produces quality warnings. Failure falls back to ASR timing.

## Planner and patches

The OpenAI adapter implements a vendor-neutral structured-generation contract over the Responses API. Strategy, Edit, and Patch Planner remain separate roles and prompts. Provider JSON is parsed, Zod-validated, retried with targeted repair feedback, then semantically validated by the existing engine. Provider/model/request/latency/token/retry/validation metadata is persisted separately from project content.

EditPatch is first-class. It declares timeline ranges, segments and tracks before operations. Local feedback is guarded against unexpectedly global mutation. Applying a patch creates a new EditPlan, Timeline diff, immutable Version and operation provenance; unrelated source selections remain unchanged.

## Jobs

Workflow remains the product state machine. Durable Job files represent execution state only. The local FIFO queue provides bounded/type-specific concurrency, per-project serialization, idempotency keys, monotonic progress events, classified bounded retry with jitter, cancellation via AbortSignal, recovery of interrupted running jobs, and explicit shutdown. Long operations can be enqueued without changing synchronous compatibility methods.

## Rendering

FFmpeg receives argument arrays, never agent-authored shell strings. The renderer trims and concatenates visual clips, preserves or retimes original audio, burns editable captions, mixes narration, and applies explicit side-chain ducking. Preview supports partial ranges and a faster profile; final export requires approval of the active version.

## Hosts

The domain runtime depends on injected host contracts rather than on Node. The Node host supplies the OS filesystem, environment secrets, `fetch`, and FFmpeg. A mobile host supplies app-sandbox storage, Keychain or AndroidKeyStore, native HTTP, and AVFoundation or Media3. Both compose the same `VideoAgentCore` with the same Workflow, EditPlan, Timeline, Version and Job semantics — there is no host-specific editing model. See [mobile/README.md](mobile/README.md).

## Voice identity and mobile API

VoiceReference evidence is analyzed before an explicitly authorized VoiceProfile is enrolled or designed. Providers create SpeechAssets; editing mutations then enter AudioClip/Caption clips through EditPatch, Timeline and immutable Version before FFmpeg. Dubbing is a Timeline track, not a second mobile-specific edit model. The bearer-authenticated network API is a thin adapter over VideoAgentCore and the same durable jobs.
