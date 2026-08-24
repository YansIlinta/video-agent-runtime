# Real speech/model acceptance

`npm run eval:speech-real` is the credential/model-gated acceptance harness for real ASR, structured LLM, TTS, and authorized voice-clone execution.

It is intentionally separate from normal CI. CI must not download large model weights or require paid credentials. A disabled run exits successfully and records `status: skipped`; an explicitly enabled run exits non-zero when any requested real stage is blocked or fails.

## Default fixture

The default input is `evals/real-fixtures/one-speaker.mp4`, a small legally reusable developer fixture derived from the MIT-licensed faster-whisper test corpus. Override it with `VIDEO_AGENT_ACCEPTANCE_INPUT` for target-hardware validation.

## Stages

Set `VIDEO_AGENT_ACCEPTANCE_STAGES` to a comma-separated subset of:

- `asr`: import the real video, run the configured ASR, record timestamped transcript counts, warnings, wall latency, and ASR real-time factor.
- `llm`: use the real transcript to request a structured `EditingStrategy` from the configured production planner.
- `tts`: synthesize a short real sample through the configured TTS provider and record duration, bytes, word-timing count, latency, and TTS real-time factor.
- `clone`: explicitly authorized transcript-backed voice enrollment followed by speech generation from the saved `VoiceProfile`.

The default is `asr,llm,tts`.

## Example: hosted OpenAI acceptance

```bash
VIDEO_AGENT_REAL_ACCEPTANCE=true \
VIDEO_AGENT_ASR=openai \
VIDEO_AGENT_PLANNER=openai \
VIDEO_AGENT_TTS=openai \
OPENAI_API_KEY=... \
npm run eval:speech-real
```

This validates the configured edit-safe ASR, structured planner, and preset TTS path. Credentials are read from the environment and are never written to the JSON report.

## Example: local ASR + local TTS + hosted planner

```bash
VIDEO_AGENT_REAL_ACCEPTANCE=true \
VIDEO_AGENT_ASR=qwen3-asr \
VIDEO_AGENT_ASR_MODEL=Qwen/Qwen3-ASR-0.6B \
VIDEO_AGENT_TTS=kokoro \
VIDEO_AGENT_PLANNER=openai \
OPENAI_API_KEY=... \
VIDEO_AGENT_PYTHON=/path/to/python \
npm run eval:speech-real
```

The selected Python environment must already contain the corresponding runtime packages/model access. The harness does not silently substitute fake providers.

## Example: authorized Qwen3 voice clone

Only run the clone stage when the reference voice is yours or you otherwise have explicit authorization to clone it.

```bash
VIDEO_AGENT_REAL_ACCEPTANCE=true \
VIDEO_AGENT_ACCEPTANCE_STAGES=asr,clone \
VIDEO_AGENT_ASR=qwen3-asr \
VIDEO_AGENT_TTS=qwen3-tts \
VIDEO_AGENT_PYTHON=/path/to/python \
VIDEO_AGENT_ACCEPTANCE_AUTHORIZED_VOICE=true \
VIDEO_AGENT_ACCEPTANCE_AUTH_GRANTED_BY=self \
VIDEO_AGENT_ACCEPTANCE_AUTH_EVIDENCE='explicit acceptance-test authorization' \
npm run eval:speech-real
```

For hosted providers that require a provider-native consent object, also set `VIDEO_AGENT_ACCEPTANCE_PROVIDER_AUTHORIZATION_ID`.

If the material contains multiple speakers, set `VIDEO_AGENT_ACCEPTANCE_SPEAKER_ID`. The harness will not auto-clone an arbitrary detected person.

## Output and privacy

Reports are written to `evals/results/` by default, which is gitignored. Override with `VIDEO_AGENT_ACCEPTANCE_REPORT` and `VIDEO_AGENT_ACCEPTANCE_WORKSPACE`.

Reports contain provider/model identifiers, capabilities, health, stage metrics, transcript counts, and voice quality numbers. They do **not** contain API keys or the authorization-evidence string. The acceptance workspace may contain the project-local authorization record and generated speech assets, so treat that workspace as sensitive when testing real voices.

Local Qwen voice artifacts are redirected into the acceptance workspace by default instead of the user's normal `~/.video-agent` voice directory.

## Metrics and claim boundary

The harness records:

- wall-clock latency per stage;
- ASR and TTS real-time factor where meaningful;
- Node controller peak RSS;
- coarse total GPU memory in use from `nvidia-smi`, when available;
- provider/model/capability/health metadata;
- voice-reference quality evidence for clone runs.

`controllerPeakRssMiB` is **not** total model memory. Python/native child processes are outside Node RSS. `systemGpuPeakUsedMiB` is a coarse machine-level sample and is not process-attributed. For production capacity planning, pair this report with platform-native process/GPU telemetry on the actual deployment hardware.

A real run is considered `passed` only when every requested stage executes successfully. A requested stage using a fake provider, missing credentials/runtime, unsupported preset voice, or missing clone authorization is `blocked`, not passed.
