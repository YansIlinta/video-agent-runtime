# Mobile Local ASR/TTS Evaluation

## ASR recommendation

Start with **whisper.cpp tiny/base quantized** as the first conformance provider. It has official iOS and Android examples, a C API, quantization, Apple Metal/Core ML support, and documented memory figures. Its own current README estimates roughly 273 MB for tiny and 388 MB for base before app/media overhead, so mobile resource policy must not default to larger models. Source: https://github.com/ggml-org/whisper.cpp

Evaluate **sherpa-onnx** in parallel for languages/models where it offers a better footprint or for a unified local ASR/TTS/diarization stack. Its official project supports Android/iOS, Kotlin/Swift/Dart/JavaScript/C APIs and local ASR, TTS, VAD and diarization. Source: https://github.com/k2-fsa/sherpa-onnx

Alignment and diarization remain optional capabilities. A transcript must preserve `timingSource`, warnings and quality gaps when a mobile provider supplies only segment timestamps.

## TTS recommendation

Use sherpa-onnx-supported TTS models as the first mobile feasibility path because the same maintained native runtime exposes iOS/Android APIs. Keep Kokoro ONNX as an evaluation candidate only after license, tokenizer, phonemizer, voice asset size, cold-start memory and device benchmarks are recorded. Do not claim the existing Python Kokoro sidecar is mobile-ready.

Voice cloning is an optional high-risk capability. It remains disabled unless the native provider advertises it and the existing authorization/consent/deletion workflow passes unchanged.

## Benchmark plan (not yet real-device results)

Reference tiers: low Android (4–6 GB RAM), mid Android, flagship Android, supported older iPhone, current iPhone. For each provider/model and 1/5/20-minute audio fixtures record:

- model download and on-disk size;
- cold/warm initialization;
- real-time factor and time-to-first-segment;
- peak resident memory;
- word/segment timestamp coverage and WER fixture score;
- battery delta, energy log and thermal-state transitions;
- cancellation latency, app-background behavior and restart recovery;
- output cache hit latency and storage growth.

No true device benchmark is claimed in this milestone. The implemented benchmark covers only portable orchestration/storage/render-fixture overhead on this Windows Node host.

