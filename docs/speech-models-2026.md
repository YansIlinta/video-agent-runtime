# Speech model choices — August 2026

This document is a product/runtime decision record, not a benchmark claim. Upstream capabilities and current public pricing/licenses were checked on 2026-08-24. A model is not considered supported merely because it appears in this table; executable support is tracked separately.

## Selection rules for this runtime

1. Editing ASR must produce timestamped evidence. Text-only recognition is not an acceptable editing backend.
2. Speaker diarization and forced alignment are capabilities, not assumptions. They may be separate enrichment providers.
3. Local models are loaded only when selected. The default runtime must not reserve GPU/RAM for optional speech models.
4. Voice cloning requires explicit authorization and provenance. A reference uploaded by the user is not automatically an authorized cloned voice.
5. Code license, model-weight license, voice/reference rights and hosted API terms are separate checks.
6. `implemented` means a provider/adapter exists in this repository. It does not mean the model has been benchmarked on the current host.

## ASR matrix

| Candidate | Cost / deployment | Editing-relevant strengths | Important limits | License / terms | Runtime status |
| --- | --- | --- | --- | --- | --- |
| **Qwen3-ASR 0.6B / 1.7B + Qwen3-ForcedAligner-0.6B** | Free local/self-hosted; DashScope API also exists | 52 languages/dialects, including 22 Chinese dialects; offline + streaming upstream; long audio; forced alignment in 11 languages | Forced aligner is another 0.6B model; this repo's first adapter is short-lived Python/Transformers rather than a persistent vLLM service | Upstream repository/package Apache-2.0; verify each redistributed model artifact/model card at release time | **implemented on Node, runtime-gated** |
| **faster-whisper** | Free local | Mature CTranslate2 baseline, word timestamps, VAD, CPU/GPU | No native speaker diarization; large checkpoints still cost RAM/VRAM | MIT code; verify selected Whisper checkpoint terms/artifacts | **implemented** |
| **WhisperX** | Free local | Alignment + diarization enrichment; useful after an ASR transcript | Heavier pipeline and optional models/tokens; should not block baseline ASR | Check code and each alignment/diarization model separately | **implemented as optional enrichment** |
| **SenseVoiceSmall** | Free local; mobile/edge variants worth evaluating | Very strong Chinese-focused path; Mandarin/Cantonese/English/Japanese/Korean core; language ID, emotion and audio-event information; timestamp/diarization ecosystem | Exact mobile conversion and weight artifact must be measured/licensed separately | Source MIT. Official weights use the FunASR model agreement; upstream clarified commercial use of official SenseVoiceSmall is allowed when its attribution/model terms are followed | candidate |
| **whisper.cpp** | Free local | C/C++, quantization, CPU, Metal/Core ML, iOS, Android, offline; excellent mobile candidate | Accuracy remains checkpoint-dependent; diarization is not the core feature | MIT code; verify selected model weights | candidate, **mobile priority** |
| **OpenAI transcription** | Paid hosted BYOK | `gpt-4o-transcribe-diarize` provides speaker-aware segments; `whisper-1` verbose output provides word/segment timestamps; newer `gpt-transcribe` is cheap/high-accuracy for text transcription | Model capabilities differ. Do not route edit plans through a model/mode that lacks timestamps | Hosted API terms | **implemented for edit-safe timestamp modes** |
| **Deepgram Nova-3** | Paid hosted | Strong production STT, multilingual, language detection, keyterm prompting and speaker diarization | Diarization is an additional priced feature; not yet integrated | Hosted API terms | candidate |

### Current public hosted pricing snapshot

- OpenAI `gpt-transcribe`: **$0.0045/minute** on the current pricing page.
- OpenAI `gpt-4o-transcribe`: estimated **$0.006/minute**; token pricing is $2.50/M audio input tokens and $10/M output tokens.
- OpenAI `gpt-4o-transcribe-diarize`: $2.50/M audio input tokens and $10/M output tokens; Free tier is not supported on its model page.
- Deepgram Nova-3 pre-recorded PAYG: **$0.0043/min monolingual**, **$0.0052/min multilingual**; speaker diarization is currently listed at **+$0.0020/min**.

Prices change. Never bake these numbers into billing logic; they are only a decision snapshot.

## ASR recommendation

For this project today:

- **Desktop/local Chinese + multilingual quality:** benchmark Qwen3-ASR 0.6B first; use the ForcedAligner whenever timestamps are required.
- **Stable lightweight workstation fallback:** faster-whisper.
- **Speaker-heavy interview/podcast without local GPU setup:** OpenAI diarized ASR now; Deepgram Nova-3 is the next hosted adapter worth evaluating.
- **Mobile/offline:** whisper.cpp is the first native candidate to benchmark. Do not put Qwen3-ASR inside the mobile app until actual model size, memory, thermal and battery measurements justify it.
- **Alignment/diarization enrichment:** keep WhisperX optional; do not make it a mandatory dependency of every transcription.

## TTS / voice matrix

| Candidate | Cost / deployment | Strengths | Important limits | License / terms | Runtime status |
| --- | --- | --- | --- | --- | --- |
| **Kokoro-82M** | Free local | Very small/fast preset-voice narration baseline | No real voice-cloning identity system | Verify exact distributed checkpoint/voice assets; current runtime keeps it as local preset TTS | **implemented** |
| **Qwen3-TTS Base / VoiceDesign** | Free local/self-hosted | 0.6B/1.7B Base zero-shot cloning; 1.7B VoiceDesign; multilingual; official workflow supports Voice Design -> reusable clone prompt; reference text improves ICL clone quality | GPU/CPU cost must be measured. This repository deliberately uses short-lived sidecars first instead of keeping models resident in VRAM | Official repository Apache-2.0; voice references still require user authorization | **implemented on Node, runtime-gated** |
| **CosyVoice 3 / Fun-CosyVoice3-0.5B** | Free local/self-hosted | Strong Chinese/dialects, multilingual/cross-lingual zero-shot cloning, instruction control, streaming upstream | More dependencies/deployment surface than needed for the first runtime; exact checkpoint terms must be audited | Repository is Apache-2.0; verify exact checkpoint/model-card terms | candidate |
| **Fish Speech S2-Pro** | Local/self-hosted, but commercial license required | High-quality expressive cloning/generation and useful quality benchmark | Official inference docs recommend **at least 24 GB GPU memory**; poor default for a lightweight runtime | Fish Audio Research License: research/non-commercial free; commercial use requires a separate written license | research benchmark only |
| **IndexTTS2** | Local/self-hosted | Strong zero-shot timbre reconstruction, emotion/timbre separation, duration/emotion control | Custom model license; large organizations above specified revenue/MAU thresholds require separate licensing; commercial users should review terms carefully | bilibili Model Use License Agreement | candidate / license review |
| **F5-TTS** | Local/self-hosted | Useful zero-shot/reference-TTS research baseline | Official pretrained weights are non-commercial | MIT code, official pretrained weights CC-BY-NC-4.0 | research benchmark only |
| **OpenAI gpt-4o-mini-tts / eligible custom voices** | Paid hosted BYOK | Easy zero-server mobile narration; provider-managed infrastructure | Hosted; normal TTS is not equivalent to local voice cloning. Custom voice flows depend on account eligibility/provider consent requirements | Hosted API terms | **implemented for TTS; custom voice path eligibility-gated** |

Current OpenAI `gpt-4o-mini-tts` model page lists $0.60/M text input tokens and $12/M audio output tokens. Treat this as a current snapshot, not a constant.

## Voice cloning architecture

Voice cloning remains a `VoiceProfile` workflow, not a `clone=true` TTS flag:

```text
Authorized source video / recording
        |
        v
ASR + diarization + quality evidence
        |
        v
Select a clean 3–15 s single-speaker reference
        |
        +---- exact transcript for that range
        v
VoiceProvider.enrollVoice()
        |
        v
VoiceProfile(status=preview, authorization=authorized)
        |
        v
Generate sample -> user approves -> status=active
        |
        v
TTS/clone -> SpeechAsset -> Timeline AudioClip -> Version -> Preview
```

For Qwen3-TTS specifically, the high-quality ICL path should pass both a clean reference clip and its matching transcript. If exact reference text is unavailable, the provider may use x-vector-only mode, but it must record that degraded mode in provider metadata rather than pretending it used the higher-fidelity ICL path.

Voice Design is preferred when the user asks for a *type* of voice rather than a specific person's identity. Qwen's official documentation explicitly describes the practical `VoiceDesign -> reference clip -> create_voice_clone_prompt -> reusable cloned speaker` workflow. This repository implements the same product idea while retaining consent/provenance boundaries for real-person clones.

## Why we are not implementing every candidate now

A provider count is not a product capability. Five Python model stacks loaded or installed together would increase dependency conflicts, disk usage, support burden and potentially RAM/VRAM residency without improving the normal editing path.

The runtime therefore keeps a curated executable set:

- ASR: faster-whisper, Qwen3-ASR, OpenAI (+ WhisperX enrichment)
- TTS/voice: Kokoro, Qwen3-TTS, OpenAI

SenseVoice, whisper.cpp, Deepgram and CosyVoice are the next serious candidates because each adds a distinct capability: mobile/local, hosted production diarization, or Chinese clone quality. Fish S2-Pro, IndexTTS2 and F5-TTS remain benchmark/license-review choices rather than defaults.

## Upstream sources checked

- Qwen3-ASR: https://github.com/QwenLM/Qwen3-ASR
- Qwen3-TTS: https://github.com/QwenLM/Qwen3-TTS
- SenseVoice: https://github.com/QwenAudio/SenseVoice
- whisper.cpp: https://github.com/ggml-org/whisper.cpp
- faster-whisper: https://github.com/SYSTRAN/faster-whisper
- WhisperX: https://github.com/m-bain/whisperX
- CosyVoice: https://github.com/FunAudioLLM/CosyVoice
- Fish Speech: https://github.com/fishaudio/fish-speech
- IndexTTS2: https://github.com/index-tts/index-tts
- F5-TTS: https://github.com/SWivid/F5-TTS
- OpenAI model/pricing docs: https://developers.openai.com/api/docs/models/ and https://platform.openai.com/pricing
- Deepgram pricing: https://deepgram.com/pricing
