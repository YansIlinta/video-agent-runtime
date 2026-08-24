# Benchmarks

All figures below were measured on 2026-08-24 on the local Windows development machine (Node v24.14.1, FFmpeg 6.0 essentials, Windows x64). CPU model and installed RAM were unavailable to the sandbox and are intentionally not reported.

**These are development measurements, not production capacity claims.** Each section states what it does *not* measure. Unmeasured fields are left unmeasured rather than estimated.

---

## Rendering and end-to-end workflow

Fixture: locally generated 8-second 640×360 test source. Output profile: 1080×1920 H.264/AAC. Selected V1 timeline: 4.466667 seconds; patched/final timeline: 3.7 seconds.

| Measurement | Result |
| --- | ---: |
| Fake ASR normalization/persistence | 59 ms |
| First proxy preview | 1,299 ms |
| First preview size | 1,657,991 bytes |
| Final render | 1,686 ms |
| Final render wall/media ratio | 0.456× real time |
| Final effective speed | 2.19× real time |
| Preview/final self-check | passed |
| Visual range inspection | 3 keyframes, 1 detected shot |

The demo measured the semantic workflow, not only rendering: strategy approval, initial version, range feedback, PATCH diagnosis, local PatchPlan validation/diff/apply, second preview, narration/ducking, third preview, final approval and export.

Command: `npm run demo`.

## Job queue throughput

Repeated `npm run benchmark:queue` runs persisted and completed 50 no-op jobs across five projects with configured concurrency 4 in 754–2,203 ms: **22.7–66.3 jobs/second**.

This mostly measures local JSON/event persistence and scheduler overhead; the range reflects development-machine and filesystem variance. Per-project serialization remained enabled. A high-rate run exposed two scheduler races during development; both now have regression coverage and explicit queue shutdown semantics.

## Planner evaluation

The five-fixture fake-provider corpus produced:

| Metric | Result |
| --- | ---: |
| Valid structured output | 100% |
| Strategy consistency | 60% |
| Duration compliance | 100% |
| Protected-content retention | 100% |
| Duplicate-removal constraint | 100% |
| Hook-quality proxy | 60% |
| Semantic coverage | 100% |
| Unnecessary edit count | 0 |

The 60% strategy/hook scores are retained as honest baseline weaknesses of the deterministic fake planner. They are not hand-adjusted to make the benchmark look perfect. Hosted-provider evaluation is implemented but was not run because `OPENAI_API_KEY` was not present.

Command: `npm run eval`.

## Voice infrastructure

These numbers use `FakeVoiceProvider`; they measure orchestration, validation, JSON persistence, cache lookup, patch/version creation and queue behavior. They are **not** speech quality or model inference claims.

| Operation | Measured result |
| --- | ---: |
| Reference analysis | 22.4–141.6 ms |
| Cached reference analysis | 6.9–11.1 ms |
| Authorized fake enrollment | 23.3–163.0 ms |
| Fake speech generation | 40.1–160.0 ms |
| Cached speech lookup | 33.3–177.3 ms |
| Speech replacement → validated patch → immutable v2 | 1,488.6–1,543.4 ms |
| Spanish dubbing + captions → validated patch → immutable v3 | 1,098.4–1,927.4 ms |
| Cache identity reused the same SpeechAsset | yes |

These are two development runs. One cached generation was faster and one slower than first generation because the fake provider is computationally trivial while persisted JSON scans and filesystem variance dominate. The range should not be interpreted as real-provider cache performance.

Cancellation, transient retry, permanent failure classification, voice-profile security filtering and authenticated API behavior are tested separately.

Commands: `npm run benchmark:voice`, `npm run eval:voice`.

## Mobile host simulation

100 iterations, portable composition only.

| Benchmark | Median | p95 | Max |
|---|---:|---:|---:|
| Zero-server Mobile Host simulation (v0.3.0) | 0.502 ms | 1.418 ms | 17.209 ms |
| Zero-server Mobile Host simulation (v0.4.0) | 0.363 ms | 1.363 ms | 11.305 ms |

Every iteration created a project, imported a logical in-memory video asset, produced a deterministic local transcript, created a remote-text-only fake strategy/EditPlan, validated/applied it into Timeline/Version, and wrote a local preview artifact. `backendRequests` was `0` and final version was `1`.

**Scope warning:** this measures portable orchestration, schema validation, hashing and in-memory fixture storage/rendering on the development PC. It is not an AVFoundation/Media3 codec benchmark, local-model benchmark, battery test or real-device claim.

Command: `npm run benchmark:mobile-host`.

---

## Explicitly not measured

### Local speech models

faster-whisper, WhisperX and Kokoro Python modules were not installed in the active Python runtime, and no Hugging Face token was configured. Their provider health checks correctly report unavailable. Real-model ASR latency, alignment/diarization accuracy, Kokoro latency, GPU utilization and real-provider structured-output rate are therefore not claimed.

No local Qwen3-TTS, CosyVoice 3, Fish S2, IndexTTS 2.5, F5-TTS or Kokoro model runtime was installed. `OPENAI_API_KEY` and hosted custom-voice eligibility were unavailable. Speaker similarity, intelligibility, real duration-fit error, long-form drift, cross-language consistency, loudness variance, first-audio latency, RTF, VRAM and peak memory are unmeasured. `npm run eval:voice` reports these as gated.

### Host resources

Peak memory and CPU utilization were not measured reliably in the current sandbox. They remain open benchmark fields.

### Real devices

No iOS or Android target was compiled or run. Mobile memory, thermal, battery, disk and output-size measurements do not exist. See [mobile/native-host-status.md](mobile/native-host-status.md) for the required device measurement pass and [mobile/local-models.md](mobile/local-models.md) for the on-device model plan.
