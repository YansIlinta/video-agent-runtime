# Development guide

This document contains the day-to-day engineering setup for Video Agent Runtime. The root [README](../README.md) is the product overview; [architecture.md](architecture.md) is the design reference.

## Requirements

- Node.js 22+
- npm
- FFmpeg / FFprobe for real media rendering
- Optional Python environment for local ASR/TTS/alignment providers
- Optional provider credentials for hosted-model acceptance

Install and verify the default deterministic path:

```sh
npm install
npm run typecheck
npm test
npm run build
npm run smoke:mcp
npm run smoke:speech-mcp
npm run demo
```

The default provider configuration is intentionally deterministic and does not require a paid API call.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run cli -- --help` | Full CLI command list |
| `npm run cli -- doctor` | Provider/binary health without intentionally making a paid generation request |
| `npm run mcp` | Start the full project MCP server from source |
| `npm run speech:mcp` | Start the lightweight speech MCP from source |
| `npm run smoke:mcp` | Full MCP smoke |
| `npm run smoke:speech-mcp` | Lightweight speech MCP smoke |
| `npm run demo` | Deterministic project workflow plus real FFmpeg preview/final export |
| `npm run eval` | Golden semantic evaluation corpus |
| `npm run eval:speech-real` | Opt-in real ASR / LLM / TTS / authorized clone acceptance |
| `npm run benchmark:speech-summary` | Aggregate repeated real-provider acceptance results |
| `npm run benchmark:queue` | Durable queue benchmark |
| `npm run typecheck:mobile` | React Native TypeScript contract check |

## Runtime configuration

`.env.example` is the source of truth for currently exposed environment options. Do not copy API keys into project JSON or checked-in configuration.

### Workspace

```sh
VIDEO_AGENT_WORKSPACE=./video-projects
```

The configured workspace is the runtime boundary for durable projects and generated artifacts.

### Planner

```sh
VIDEO_AGENT_PLANNER=openai
OPENAI_MODEL=gpt-5.4-mini
OPENAI_API_KEY=...
```

The planner emits structured output that is independently validated by the runtime. Provider output is never treated as an already-valid EditPlan/EditPatch merely because the upstream API returned JSON.

### ASR

Supported runtime selections are documented in `.env.example` and currently include:

```sh
VIDEO_AGENT_ASR=fake
VIDEO_AGENT_ASR=faster-whisper
VIDEO_AGENT_ASR=qwen3-asr
VIDEO_AGENT_ASR=openai
```

Examples:

```sh
# Local faster-whisper
VIDEO_AGENT_ASR=faster-whisper
VIDEO_AGENT_ASR_MODEL=small
VIDEO_AGENT_PYTHON=python

# Local Qwen3-ASR
VIDEO_AGENT_ASR=qwen3-asr
VIDEO_AGENT_ASR_MODEL=Qwen/Qwen3-ASR-0.6B
VIDEO_AGENT_PYTHON=python

# Hosted diarized transcription
VIDEO_AGENT_ASR=openai
VIDEO_AGENT_ASR_MODEL=gpt-4o-transcribe-diarize
OPENAI_API_KEY=...
```

For edit-safe ASR, timestamped segments are mandatory. Word timestamps and speaker labels are capability-dependent. Optional WhisperX alignment/diarization enriches the canonical Transcript rather than creating a second transcript model.

### TTS and voice

```sh
VIDEO_AGENT_TTS=fake
VIDEO_AGENT_TTS=kokoro
VIDEO_AGENT_TTS=qwen3-tts
VIDEO_AGENT_TTS=openai
```

Qwen3-TTS is also used for maintained Voice Design / authorized cloning paths. Voice cloning is not enabled merely because a source asset contains speech; authorization and reference-quality rules still apply.

Read [speech-models-2026.md](speech-models-2026.md) and [voice-identity.md](voice-identity.md) before making deployment or commercial-license claims about a model.

## MCP development

Build output exposes two MCP entry points:

```text
video-agent-mcp
video-agent-speech-mcp
```

The full MCP is project-oriented and uses `VideoAgentCore`. The speech MCP intentionally stays lightweight for ASR → structured transform → TTS, but it reuses shared provider contracts rather than maintaining a parallel provider runtime.

Use [`../mcp.example.json`](../mcp.example.json) as a minimal stdio client configuration.

Rules for MCP changes:

- Do not mutate Project/Timeline files directly from MCP handlers.
- Do not expose arbitrary shell execution or raw FFmpeg command strings.
- Add high-level tools only when they represent a stable runtime capability.
- Reuse `VideoAgentCore` or shared provider contracts; do not reimplement domain behavior in the transport layer.
- Do not increase tool count merely to make the MCP surface appear richer.

## Package boundaries

```text
apps/
  cli/                 CLI transport
  mobile/              React Native shell

packages/
  core/                schemas + deterministic domain/edit logic
  runtime/             VideoAgentCore and host composition
  providers/           provider contracts/adapters
  jobs/                durable execution
  media/               media/process helpers
  mcp/                 full project MCP
  speech/              shared speech provider/pipeline code
  speech-mcp/          lightweight speech transport
  mobile/              portable mobile host adapters
```

The dependency direction should stay roughly:

```text
transport / host
      ↓
VideoAgentCore / shared provider service
      ↓
core domain contracts
```

`core` must not become dependent on Node process APIs, React Native APIs, provider SDKs, or transport-layer code.

## Performance rules

Performance work should target measured costs rather than class/interface counts.

Avoid:

- reading multi-GB media with `readFile()` when streaming is possible;
- moving large media through React Native as base64 or `number[]`;
- rescanning all durable job/project files on every scheduler tick;
- unbounded provider metadata caches;
- loading local speech models during normal startup when no speech request needs them;
- declaring provider/renderer capabilities that the adapter does not actually implement.

Keep durability where it protects correctness. A durable Version, Job or Project record is not considered over-design merely because it has an in-memory counterpart.

## Testing strategy

For ordinary runtime changes, run:

```sh
npm run typecheck
npm test
npm run build
```

When touching MCP:

```sh
npm run smoke:mcp
npm run smoke:speech-mcp
```

When touching mobile TypeScript contracts:

```sh
npm --prefix apps/mobile ci
npm run typecheck:mobile
```

Large local models and paid hosted credentials are not required by normal CI. Use the explicit real-provider harness instead:

```sh
VIDEO_AGENT_REAL_ACCEPTANCE=true \
VIDEO_AGENT_ASR=... \
VIDEO_AGENT_PLANNER=... \
VIDEO_AGENT_TTS=... \
npm run eval:speech-real
```

Then aggregate repeated runs:

```sh
npm run benchmark:speech-summary
```

See [real-speech-acceptance.md](real-speech-acceptance.md) for authorization and measurement boundaries.

## Mobile development

The React Native target is a separate compilation unit from the Node `NodeNext` project.

Start with:

```sh
npm run mobile:install
npm run typecheck:mobile
```

TypeScript contract success is not evidence that Swift/Kotlin native targets compile or that a physical device completes import/render/export. Use [mobile/native-host-status.md](mobile/native-host-status.md) as the claim boundary.

Do not introduce a mobile-only Timeline, Workflow, Job Queue or editing model. Platform behavior belongs behind injected host/native capabilities.

## Security and secrets

- API keys come from environment or platform secure storage.
- Persist credential references, not secret values.
- Do not include Authorization headers, prompts, transcripts or voice authorization evidence in network audit records.
- Voice reference material is sensitive project data.
- Agents do not receive raw shell access through editing tools.
- Paths must stay inside the configured workspace/project boundaries.

See [security.md](security.md).

## Documentation and claims

When a public behavior changes, update the closest technical document and the root README only when the change is product-visible.

Use precise claims:

- source implementation exists;
- typechecked;
- unit/contract tested;
- simulator tested;
- physical-device tested;
- measured on a named device/runtime.

Do not collapse those into broad statements such as “production ready”, “mobile ready”, “fully local”, or “zero-copy” unless the corresponding evidence exists.

Historical release reports belong under `docs/releases/`; current technical truth belongs in the topic documents.
