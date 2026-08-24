# V2 voice infrastructure benchmarks

Measured 2026-08-24 on the local Windows development environment. These numbers use `FakeVoiceProvider`; they measure orchestration, validation, JSON persistence, cache lookup, patch/version creation and queue behavior. They are **not** speech quality or model inference claims.

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

## Not executed

No local Qwen3-TTS, CosyVoice 3, Fish S2, IndexTTS 2.5, F5-TTS or Kokoro model runtime was installed. `OPENAI_API_KEY` and hosted custom-voice eligibility were unavailable. Speaker similarity, intelligibility, real duration-fit error, long-form drift, cross-language consistency, loudness variance, first-audio latency, RTF, VRAM and peak memory are explicitly unmeasured. `npm run eval:voice` reports these as gated.
