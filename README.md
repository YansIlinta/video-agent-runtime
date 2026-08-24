# Video Agent Runtime

An agent-native, headless video editing system.

It turns source media into durable transcript and timeline data, asks for editing-strategy approval, validates and applies structured edit plans, renders fast previews, processes structured feedback, diagnoses strategy failures, versions every change, and exports only after explicit approval.

**This is not a desktop NLE.** It does not expose arbitrary shell access or raw FFmpeg to agents. Agents get a constrained, schema-validated tool surface; the runtime owns every mutation.

## Capabilities

| Area | What it does |
| --- | --- |
| **Durable edit model** | Integer-microsecond Timeline, first-class EditPlan and EditPatch, immutable Versions, atomic writes with per-project locking |
| **Approval workflow** | Strategy proposal → approval → plan validation → version → preview → feedback → diagnosis → final approval → export. No step can be skipped |
| **Structured planning** | OpenAI Responses adapter behind a vendor-neutral contract: JSON Schema generation, independent Zod validation, targeted repair retries, persisted call provenance |
| **Speech** | Deterministic offline providers by default; optional faster-whisper, WhisperX alignment/diarization, and Kokoro sidecars behind capability-driven interfaces |
| **Voice identity** | Authorized VoiceProfile enrollment, description-driven design, provenance-rich TTS, deterministic duration fitting, multilingual dubbing and captions, secure deletion |
| **Rendering** | FFmpeg preview/final renderer behind a `Renderer` interface — argument arrays only, never agent-authored shell strings |
| **Durable jobs** | Local queue with bounded concurrency, progress events, classified retries, idempotency, cancellation, restart recovery and quotas |
| **Evaluation** | Golden semantic evaluations plus legally reusable speech fixtures |

## Surfaces

| Surface | Entry point |
| --- | --- |
| CLI | `video-agent` — `create`, `import`, `transcribe`, `propose`, `approve`, `plan`, `validate`, `preview`, `feedback`, `diagnose`, `patch`, `versions`, `restore`, `export`, `doctor`, … |
| MCP server | `video-agent-mcp` — 59 project-scoped stdio tools with structured input/output contracts |
| Agent skill | [`skills/video-editing/SKILL.md`](skills/video-editing/SKILL.md) — workflow and safety policy |
| Control API | Bearer-authenticated local HTTP surface — see [docs/control-api.md](docs/control-api.md) |
| Mobile host | Zero-server iOS/Android native host — see [docs/mobile/](docs/mobile/README.md) |

All of them are thin adapters over the same `VideoAgentCore`. None may mutate project JSON or invoke FFmpeg directly.

## Getting started

```sh
npm install
npm test
npm run build
npm run smoke:mcp
npm run demo
```

Copy `.env.example` values into your process environment and set `VIDEO_AGENT_WORKSPACE` to the only directory that may contain projects. Run `npm run cli -- --help` for the full command list, and `npm run cli -- doctor` to report exactly which providers and binaries are available without making a paid call.

The default fake providers are deterministic, so the full workflow is reproducible in CI. `npm run demo` synthesizes source media locally, drives the complete approval/version/narration workflow, and performs a real FFmpeg preview and final export under `work/e2e-demo`.

The mobile surface is a separate compilation unit — it cannot build under the root `module: NodeNext` config — so it has its own install and check:

```sh
npm run mobile:install
npm run typecheck:mobile
```

### Connecting an agent

Build first, then point a Codex or Claude Code stdio MCP configuration at `dist/packages/mcp/src/server.js`; `mcp.example.json` shows the shape. Secrets are read from provider-specific environment variables and are never written into project files.

### Enabling real providers

| Provider | How |
| --- | --- |
| Hosted planner | Set `VIDEO_AGENT_PLANNER=openai`, `OPENAI_MODEL`, `OPENAI_API_KEY` |
| Local ASR | Install faster-whisper into the interpreter selected by `VIDEO_AGENT_PYTHON`, then set `VIDEO_AGENT_ASR=faster-whisper` |
| Alignment/diarization | Install WhisperX; the fusion layer maps aligned words and speaker intervals back into the canonical Transcript |
| Local TTS | Install Kokoro, then set `VIDEO_AGENT_TTS=kokoro` |

Real-provider evaluation stays opt-in behind `VIDEO_AGENT_EVAL_REAL=true`.

## Documentation

Start at [docs/README.md](docs/README.md) for the full index.

- [Architecture](docs/architecture.md) — packages, flow, durable project layout
- [Security](docs/security.md) — secret policy and what is filtered from responses
- [Benchmarks](docs/benchmarks.md) — every measured figure, and what was not measured
- [Mobile host](docs/mobile/README.md) — the native iOS/Android target and its current limits
- [Upstream study](docs/upstream-study.md) — prior art behind the design
- [Changelog](CHANGELOG.md) — condensed release history

## Project status

Version 0.4.0. The Node runtime — CLI, MCP, FFmpeg rendering, jobs, evaluation — is the working, verified path.

The mobile native host is a **source-complete prototype that has never been compiled or run on a device**. Its capability matrix, open defects and the required device measurement pass are documented in [docs/mobile/native-host-status.md](docs/mobile/native-host-status.md) and [docs/mobile/known-issues.md](docs/mobile/known-issues.md). Do not read the mobile capability tables as shipped behavior.

## License

MIT. See [LICENSE](LICENSE).
