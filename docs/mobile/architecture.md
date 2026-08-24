# Mobile Host Runtime Audit

Date: 2026-08-24  
Baseline: `video-agent-runtime` 0.2.0  
Decision: incremental host extraction; the existing Node CLI/MCP runtime remains supported while shared orchestration is made host-neutral.

## Audit gate and target

This document is the required gate before the mobile-host refactor. The target is not “Node running inside a phone.” The target is one domain runtime with explicit host contracts and three composition profiles:

- `node-local`: Node filesystem, process execution, FFmpeg CLI, optional Python sidecars, environment-backed credential migration.
- `ios-local`: sandbox/document-provider storage, Keychain, URLSession-compatible HTTP, AVFoundation, BGTaskScheduler, native/local model bridges.
- `android-local`: scoped/document-provider storage, Android Keystore, native HTTP, Media3/WorkManager, native/local model bridges.

The first mobile implementation in this repository is a deterministic `mobile-simulation` host. It must not require an app-owned API server and must exercise the same Project/Workflow/EditPlan/EditPatch/Timeline/Version/Job contracts.

## Classification summary

| Subsystem | Current files | Classification | Mobile-host decision |
|---|---|---|---|
| Schemas, time units, Edit IR | `packages/core/src/schemas.ts`, `time.ts`, `timeline-context.ts` | PORTABLE | Retain; add logical asset URI, host/provider/privacy schemas additively. |
| Edit/patch/feedback algorithms | `edit-engine.ts`, `patch-engine.ts`, `feedback.ts` | PORTABLE with host utilities leaking | Inject clock/ID services where object creation occurs. Algorithms remain unchanged. |
| Workflow state machine | `workflow.ts` | PORTABLE + NODE-BOUND | Replace `node:crypto` and wall-clock calls with injected `RuntimePrimitives`. |
| Project persistence | `project-store.ts` | FILESYSTEM-BOUND + NODE-BOUND | Define a domain `ProjectRepository`; keep this implementation as `NodeProjectStore`; add portable/in-memory repository for mobile simulation. |
| VideoAgentCore | `packages/runtime/src/video-agent-core.ts` | PORTABLE orchestration mixed with FILESYSTEM-BOUND/NODE-BOUND | Inject repository, asset I/O, primitives, capabilities and background execution; remove direct Node imports from the class. |
| Durable job queue | `packages/jobs/src/job-queue.ts` | BACKGROUND-EXECUTION-BOUND + PORTABLE | Inject clock/ID/background scheduler; preserve persisted Job/Event and restart recovery semantics. |
| Provider contracts/fakes | `packages/providers/src/contracts.ts`, `fakes.ts` | PORTABLE with path-shaped media inputs | Migrate media arguments to logical `AssetRef`/materialization boundary; preserve compatibility at Node adapter. |
| OpenAI planner | `packages/providers/src/openai.ts` | NETWORK-BOUND + SECRET-STORAGE-BOUND + NODE-BOUND | Inject `HttpAdapter`, credential resolver, clock and IDs; never read `process.env` in provider code. |
| OpenAI voice | `openai-voice.ts` | NETWORK-BOUND + SECRET-STORAGE-BOUND + FILESYSTEM-BOUND + NODE-BOUND | Inject HTTP and asset byte reader; move WAV parsing to portable byte utilities. |
| Faster Whisper/Kokoro/WhisperX | `packages/speech/src/*.ts`, `packages/speech/python/*.py` | PYTHON-SIDECAR-BOUND + PROCESS-BOUND + FILESYSTEM-BOUND | Keep as Node providers; mobile providers implement the same ASR/TTS contracts through native bridges. |
| FFmpeg renderer and probe | `packages/render/src/ffmpeg-renderer.ts`, `packages/media/src/*` | FFMPEG-CLI-BOUND + PROCESS-BOUND + FILESYSTEM-BOUND | Rename/position as Node media adapter. Mobile uses AVFoundation/Media3 adapters behind `MediaAdapter`. |
| Config/logger/factory | `packages/runtime/src/config.ts`, `logger.ts`, `factory.ts` | NODE-BOUND + SECRET-STORAGE-BOUND | Make these the Node composition root. Add explicit `HostProfile`; no platform checks in domain code. |
| CLI/MCP/network API | `apps/cli`, `packages/mcp`, `packages/api` | NODE-BOUND + NETWORK-BOUND | Retain as Node-only entry points. They are optional clients/hosts, never required by the mobile app. |

## Incompatibility register

### A1 — ProjectStore owns POSIX/Win32 path semantics

- File/dependency: `packages/core/src/project-store.ts`; `node:fs`, `node:fs/promises`, `node:path`, `node:crypto`, `process.pid`.
- Why incompatible: iOS and Android expose sandbox and document-provider URIs rather than arbitrary process-wide paths; neither React Native nor a native app has Node atomic rename/open semantics by default.
- Proposed abstraction: `ProjectRepository` for domain records plus `FileSystemAdapter`/`AssetIOAdapter` for bytes, logical URIs and atomic writes. Node implements these with the existing directory layout.
- Preserved behavior: schema validation, atomic replacement/backup recovery, containment, per-project serialization, cache lookup, durable Jobs/Events/Versions.
- Risk: high. Atomicity differs across content providers. Mobile adapters must stage writes inside app storage and explicitly import/export external URIs.

### A2 — Durable assets expose host paths

- File/dependency: `assetSchema.relativePath`, `ProjectStore.resolveProjectFile`, `VideoAgentCore.importVideo`, renderer/provider request paths.
- Why incompatible: absolute paths are neither stable nor transferable after app restart, security-scope changes, Android URI grants, or project migration.
- Proposed abstraction: additive `AssetRef { uri, storageClass, mediaType? }` using `project://`, `import://`, `cache://`, and `export://` logical schemes. `relativePath` remains readable during migration and is mapped to `project://<projectId>/<relativePath>`.
- Preserved behavior: asset IDs and SHA-256 provenance remain authoritative; Node output paths continue to resolve at the adapter edge.
- Risk: medium. Third-party providers and native codecs sometimes require a materialized file URL; leases must be scoped and cleaned up.

### A3 — Core generates identity and timestamps from Node/global state

- File/dependency: `workflow.ts`, `edit-engine.ts`, `patch-engine.ts`, `feedback.ts`, `fusion.ts`, `fakes.ts`, `video-agent-core.ts`; `randomUUID`, `createHash`, `Date.now`, `new Date`, `Math.random`.
- Why incompatible: `node:crypto` is unavailable in many mobile JS runtimes and global clocks/randomness prevent deterministic recovery tests.
- Proposed abstraction: `IdAdapter`, `ClockAdapter`, `CryptoAdapter`; queue jitter supplied by a host primitive.
- Preserved behavior: UUID-shaped unique IDs, ISO timestamps, SHA-256 cache/provenance keys, exponential retry.
- Risk: low to medium. Cryptographic hashing must operate on canonical bytes, not JS string implementation details.

### A4 — HTTP calls and cancellation use global fetch

- File/dependency: `providers/openai.ts`, `providers/openai-voice.ts`; global `fetch`, `RequestInit`, `FormData`, timers.
- Why incompatible: mobile fetch implementations differ in streaming, timeout, TLS/pinning, multipart files and background behavior.
- Proposed abstraction: `HttpAdapter.request()` with byte/text/stream bodies, normalized headers/status/errors, `AbortSignal`, timeout and retry hints.
- Preserved behavior: ProviderCall latency/usage/request ID/validation/retry/cancel metadata and structured output repair.
- Risk: medium. React Native streaming and multipart support depends on the native networking adapter.

### A5 — Secrets are configuration values

- File/dependency: `runtime/config.ts`, `factory.ts`, OpenAI providers; `process.env` and plain strings.
- Why incompatible: mobile environment variables do not exist at runtime and bundling keys exposes them. App storage is not an acceptable secret vault.
- Proposed abstraction: `SecureStorageAdapter { set/get/delete/has }`; durable `ProviderConfig` stores only `credentialRef`. Node environment import is a composition-root migration feature.
- Preserved behavior: existing `OPENAI_API_KEY` and `HF_TOKEN` can seed a Node credential resolver without writing the values into project JSON.
- Risk: high. BYOK direct-to-provider necessarily exposes the user's own key to the user's device; device compromise and provider CORS/client policy remain provider-specific.

### A6 — FFmpeg is the media runtime

- File/dependency: `render/ffmpeg-renderer.ts`, `media/ffprobe.ts`, `visual-evidence.ts`, `process.ts`; FFmpeg/ffprobe executables and `node:child_process`.
- Why incompatible: App Store/Play policies, binary size, codecs and sandboxing make spawning FFmpeg CLI unsuitable; mobile OSes provide native media frameworks instead.
- Proposed abstraction: `MediaAdapter` with probe, render preview/final, waveform/frame extraction, transcode/materialize and capability reporting. Existing implementation becomes `NodeFfmpegMediaAdapter`; future native implementations use AVFoundation and Media3/MediaCodec.
- Preserved behavior: Timeline remains the render source of truth, microsecond times stay intact, progress/cancellation/result/provenance remain normalized.
- Risk: high. Filter parity (caption burn-in, concat, ducking, speed, exact frame boundaries) needs golden-media conformance tests per platform.

### A7 — Speech providers spawn Python

- File/dependency: `speech/asr.ts`, `tts.ts`, `whisperx.ts`, `voice.ts`, Python sidecars; executable paths, JSON stdout and filesystem inputs.
- Why incompatible: mobile apps cannot assume Python, subprocesses, CUDA, or shell-visible files.
- Proposed abstraction: keep `ASRProvider`, `AlignmentProvider`, `DiarizationProvider`, `TTSProvider`, `VoiceProvider`; replace path parameters with logical asset/materialization handles. Add capability flags for local inference, alignment, diarization, clone and streaming.
- Preserved behavior: transcript/quality/speech schemas, cache keys, ProviderCall, consent and voice deletion semantics.
- Risk: high. Model memory, NN delegate availability, word timestamps and language quality vary by device.

### A8 — Job execution assumes a continuously alive JS process

- File/dependency: `jobs/job-queue.ts`; `setTimeout`, in-memory controllers/handlers/running counters.
- Why incompatible: iOS suspends apps and grants bounded background time; Android may kill the process and requires WorkManager/foreground-service policies for long work.
- Proposed abstraction: `BackgroundExecutionAdapter` with durable work registration, wake request, cancellation and execution budget. Persisted Job remains authoritative; `running` is recovered to queued/failed according to idempotency and handler policy.
- Preserved behavior: per-project exclusivity, type limits, retries, events, cancellation, restart recovery.
- Risk: high. Final export may not finish in an ordinary iOS background window; UI must surface “keep app active/power connected” policy.

### A9 — Runtime limits ignore mobile resources

- File/dependency: `runtime/config.ts`, queue options and FFmpeg renderer presets.
- Why incompatible: static desktop concurrency can cause memory pressure, thermal throttling or battery drain on phones.
- Proposed abstraction: `PlatformCapabilities`, `ResourceBudget` and thermal/power signals supplied by the host profile. Queue/media policy chooses concurrency, preview resolution and chunk size.
- Preserved behavior: explicit quotas and predictable failure classes; Node defaults remain unchanged.
- Risk: medium. Capability estimates are advisory and must be re-evaluated during execution.

### A10 — Network API is easy to mistake for architecture

- File/dependency: `packages/api/src/server.ts` and CLI `api` command.
- Why incompatible: a required app-owned backend violates the milestone and creates an unnecessary secret/data hop.
- Proposed abstraction: mobile UI calls a local `VideoAgentFacade`; HTTP API remains an optional Node integration surface only. Remote LLM calls are outbound through `HttpAdapter` under `RemoteContextPolicy`.
- Preserved behavior: current authenticated Node API and MCP workflows remain available.
- Risk: low, provided documentation and composition roots keep the dependency direction explicit.

### A11 — External URI import and permissions are not modeled

- File/dependency: CLI path input and `copySourceAsset` regular-file checks.
- Why incompatible: iOS photo/file pickers and Android SAF return permission-scoped identifiers; access can expire or require explicit persistent grants.
- Proposed abstraction: `ImportSource`, `PermissionAdapter`, normalized permission/error codes and an import transaction that copies into project storage when persistence is required.
- Preserved behavior: size quota, hash validation, immutable source asset record and safe filename metadata.
- Risk: medium. Very large videos require streamed copy and enough-space preflight.

### A12 — Remote context has no explicit privacy boundary

- File/dependency: planner sends compact transcript JSON; no persisted context policy or context provenance.
- Why incompatible: a mobile local-first product must make remote disclosure inspectable and user-controlled.
- Proposed abstraction: `RemoteContextPolicy` and `ContextPack` listing sources, transformations, included fields, byte/token estimates, provider and approval state. Default excludes raw media and local paths.
- Preserved behavior: remote planner still receives the transcript evidence needed for EditPlan/EditPatch.
- Risk: medium. Free-form prompts and OCR may contain sensitive data; redaction and user preview are required for stricter modes.

## Portable-core dependency rule

Files designated shared/domain may import only ECMAScript libraries, Zod schemas and explicit interfaces. They may not import `node:*`, access `process`, require absolute paths, spawn processes, call global `fetch`, or reference React Native/Swift/Kotlin APIs. Platform code may depend inward on domain code; domain code never depends outward on a platform implementation.

## Migration sequence

1. Add host contracts, logical asset/provider/privacy schemas and compatibility mappers.
2. Extract a `ProjectRepository` contract; identify the existing class as the Node implementation without changing its on-disk layout.
3. Inject primitives into Workflow/JobQueue/Core and inject HTTP/credential lookup into remote providers.
4. Introduce `NodeHostProfile` and keep CLI/MCP/factory behavior passing existing tests.
5. Add a mobile-simulation repository/media/background/secure-storage host and zero-server integration test.
6. Add native iOS/Android adapters in subsequent platform projects, using conformance suites rather than duplicating domain logic.

## Audit acceptance criteria

- Every incompatible dependency found by repository scan is owned by a named host boundary.
- Existing durable schemas are migrated additively; old projects remain readable.
- Node-only modules remain allowed, but are no longer imported by shared orchestration.
- The mobile simulation must demonstrate create/import/transcribe/plan/apply/render/version/job recovery without starting `packages/api` or any custom relay.

