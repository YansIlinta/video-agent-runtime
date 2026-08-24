# Speech MCP

`video-agent-speech-mcp` is the deliberately small path for the current product proof:

```text
local video/audio
  -> audio extraction
  -> ASR
  -> structured LLM transform/translation
  -> TTS
  -> optional translated audio mux
```

It does **not** create a Project, Timeline, EditPlan, EditPatch, Version, renderer job graph, visual evidence bundle, or mobile host. Those systems remain available through the full runtime, but they are not loaded for the speech-only path.

## Start

```sh
npm install
npm run build
npm run speech:mcp
```

Built entry point:

```text
dist/packages/speech-mcp/src/server.js
```

Example MCP command configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/video-agent-runtime/dist/packages/speech-mcp/src/server.js"],
  "env": {
    "VIDEO_AGENT_SPEECH_WORKSPACE": "/absolute/path/speech-runs"
  }
}
```

Do not place provider secrets in MCP tool arguments. Supply them through the process environment or an external secret launcher.

## Six tools only

The surface is intentionally kept small:

| Tool | Purpose |
| --- | --- |
| `speech_models` | Show the built-in provider/model catalog and model-selection semantics. The catalog is not an allow-list; model IDs remain overridable. |
| `speech_provider_health` | Check selected ASR/TTS runtimes without constructing the full video runtime. |
| `speech_transcribe` | Extract 16 kHz mono speech audio and run a selected ASR provider/model. |
| `speech_translate` | Run a selected LLM provider/model/reasoning mode and preserve one output per ASR segment. |
| `speech_synthesize` | Generate a translated speech track with a selected TTS provider/model/voice. |
| `video_translate` | Execute the entire proof flow and mux the translated audio track into the source video. |

If another feature does not serve this pipeline directly, it should normally stay out of this MCP.

## ASR selection

Current adapters:

```text
faster-whisper
qwen3-asr
```

Example model overrides:

```text
provider=faster-whisper model=small
provider=faster-whisper model=large-v3
provider=qwen3-asr model=Qwen/Qwen3-ASR-0.6B
provider=qwen3-asr model=Qwen/Qwen3-ASR-1.7B
```

Qwen3-ASR optionally uses:

```text
Qwen/Qwen3-ForcedAligner-0.6B
```

through `VIDEO_AGENT_QWEN3_ALIGNER`.

The Qwen adapter is optional. The MCP can start without the Python package or model weights; `speech_provider_health` reports it unavailable until its runtime is installed.

## LLM selection

Each translation call selects:

```text
providerKind
transport
model
reasoning
baseUrl (optional)
```

Provider kinds currently handled by the speech transport layer:

```text
openai
 deepseek
 openrouter
 openai-compatible
 custom
```

Transports:

```text
responses
chat-completions
```

Typical combinations:

```text
OpenAI        -> responses
DeepSeek      -> chat-completions
OpenRouter    -> chat-completions
Custom gateway-> chat-completions or responses when compatible
```

`model` is an arbitrary string supplied per call. The MCP does not require a repository release merely to change model IDs.

Reasoning values:

```text
off
low
medium
high
extra-high
```

Reasoning mapping is provider-aware. In particular, the DeepSeek path does not invent a generic effort field when the provider/model does not use one; choose the appropriate reasoning model instead.

Credentials are resolved in this order:

```text
VIDEO_AGENT_LLM_API_KEY
then provider-specific key:
OPENAI_API_KEY
DEEPSEEK_API_KEY
OPENROUTER_API_KEY
```

Optional generic endpoint override:

```text
VIDEO_AGENT_LLM_BASE_URL
```

## TTS selection

Current adapters:

```text
kokoro
qwen3-tts
openai
```

Examples:

```text
provider=kokoro model=hexgrad/Kokoro-82M voiceId=af_heart
provider=qwen3-tts model=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice voiceId=<supported speaker>
provider=openai model=gpt-4o-mini-tts voiceId=alloy
```

The slim Qwen3-TTS adapter currently exercises the **CustomVoice** generation path only. Voice Design and Voice Clone remain separate future capabilities; they are not silently exposed as if already implemented.

## End-to-end language replacement

`video_translate` performs:

```text
source video
  -> FFmpeg extracts 16 kHz mono WAV
  -> selected ASR
  -> selected LLM produces structured translated segments
  -> local Zod validation checks exact segment cardinality/index identity
  -> selected TTS synthesizes one segment at a time
  -> FFmpeg concatenates the generated WAV segments
  -> FFmpeg stream-copies the original video and replaces audio with AAC
  -> translated.mp4
```

This milestone deliberately implements **narration-style sequential dubbing**.

It does not yet claim:

- lip sync
- source-segment duration matching
- speaker-preserving dubbing
- music/source-vocal separation
- per-speaker voice cloning
- timeline-aware retiming
- professional mixing

Those are editing/speech-alignment problems and should not be hidden inside the first proof.

## Storage

Default run root:

```text
./speech-runs
```

Override:

```sh
VIDEO_AGENT_SPEECH_WORKSPACE=/path/to/runs
```

A run contains only the artifacts needed for the speech proof, for example:

```text
<run-id>/
  run.json
  source-16k.wav
  tts/
    segment-0000.wav
    segment-0001.wav
    concat.txt
    dubbed.wav
  translated.mp4
```

The source video itself is not copied into a ProjectStore by this path.

## Performance choices

The speech MCP intentionally avoids several costs in the full editing runtime:

- no eager Project/Timeline/Workflow construction
- no visual-analysis provider
- no renderer graph
- no project version history
- no source-video copy/hash for the speech-only proof
- ASR/TTS models are created only when their corresponding tool is invoked

The full runtime source importer previously hashed a copied video by reading the entire file into one JS buffer. That path has been changed to stream SHA-256 chunks instead, retaining content identity without a file-sized RAM spike.

ASR normalization also now computes silence regions once rather than cloning/sorting the full word list twice.

Remaining optimization candidates in the full runtime include:

- file-backed TTS output instead of temporary WAV -> full RAM buffer -> project WAV
- deterministic cache-key indexes instead of linear JSON scans
- limiting retained in-memory provider-call metadata
- avoiding expensive recursive disk-usage scans on hot paths

These should be changed based on measurements rather than by deleting durability features indiscriminately.

## Verification boundary

CI verifies:

```sh
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npm run smoke:speech-mcp
```

The smoke test starts the built MCP over stdio, verifies the surface remains exactly six tools, and calls `speech_models`.

CI does **not** download Qwen/faster-whisper/Kokoro weights and does not hold paid provider credentials. Therefore it does not prove real-model inference quality or latency.

A real `video_translate` acceptance run still requires at least one installed/credentialed ASR + LLM + TTS combination on suitable hardware.
