# Video Agent Runtime

Version 0.4 adds a React Native New Architecture native-host prototype with Swift and Kotlin adapters. Native source is present, while real-device completion is tracked honestly in `docs/v4-native-mobile-proof-report.md`.

Version 0.3 adds an explicit Mobile Host architecture while preserving the Node CLI/MCP runtime. Start with `docs/mobile-host-audit.md`, `docs/mobile-framework-evaluation.md`, `docs/provider-mobile-auth.md`, and `docs/v3-final-report.md`. Run the zero-server simulation with `npx vitest run tests/mobile-host.test.ts` and `npm run benchmark:mobile-host`.

An agent-native, headless video editing system. It turns source media into durable transcript/timeline data, asks for editing-strategy approval, validates and applies structured edit plans, renders fast previews, processes structured feedback, diagnoses strategy failures, versions every change, and exports only after explicit approval.

This is not a desktop NLE and does not expose arbitrary shell or raw FFmpeg tools to agents.

## V2 Voice Identity milestone

V2 adds authorized VoiceProfile enrollment, description-driven design, provenance-rich TTS, deterministic duration fitting, EditPatch speech replacement, multilingual dubbing/captions, secure deletion, durable voice jobs, an expanded MCP surface, and a narrow authenticated mobile/control API. The V1/V1.5 project, timeline, plan/patch, version, workflow and FFmpeg paths remain authoritative.

See `docs/v2-final-report.md`, `docs/v2-voice-model-study.md`, `docs/v2-voice-benchmarks.md`, and `docs/v2-api.md`.

## V1.5 surfaces

- `video-agent`: local CLI.
- `video-agent-mcp`: stdio MCP server with structured input/output contracts.
- `skills/video-editing/SKILL.md`: agent workflow and safety policy.
- `VideoAgentCore`: shared domain service used by both adapters.
- Optional faster-whisper, WhisperX, and Kokoro sidecars behind capability-driven provider interfaces.
- FFmpeg preview/final renderer behind a `Renderer` interface.
- OpenAI Responses structured planner with local Zod validation, repair retries, cancellation and persisted call metadata.
- First-class minimal EditPatch validation/diff/apply.
- Optional WhisperX alignment/diarization with deterministic Transcript fusion and quality reports.
- On-demand FFmpeg shot/keyframe evidence.
- Durable local jobs with progress, classified retries, idempotency, cancellation, recovery and quotas.
- Golden semantic evaluations plus legally reusable speech fixtures.

## Development

```sh
npm install
npm test
npm run build
npm run smoke:mcp
npm run demo
npm run eval
npm run benchmark:queue
```

Run `npm run cli -- --help` for commands. Copy `.env.example` values into your process environment and set `VIDEO_AGENT_WORKSPACE` to the only directory that may contain projects. The default fake providers make development reproducible; set `VIDEO_AGENT_ASR=faster-whisper` or `VIDEO_AGENT_TTS=kokoro` after installing the optional Python packages.

Build first, then point a Codex or Claude Code stdio MCP configuration at `dist/packages/mcp/src/server.js`; `mcp.example.json` shows the shape. The server exposes 44 project-scoped tools and returns structured results. Secrets are read from provider-specific environment variables and are never stored in project files.

For the first real hosted path, set `VIDEO_AGENT_PLANNER=openai`, `OPENAI_MODEL`, and `OPENAI_API_KEY`. The implementation uses the Responses API with a JSON Schema response format, then independently parses and validates with Zod. Real-provider eval remains opt-in with `VIDEO_AGENT_EVAL_REAL=true`.

For local speech, install faster-whisper and optionally WhisperX/Kokoro into the interpreter selected by `VIDEO_AGENT_PYTHON`, then select the providers in environment or `video-agent.config.json`. `video-agent doctor` reports exact availability without requiring paid calls.

The included demo synthesizes source media locally, drives the complete approval/version/narration workflow, and performs a real FFmpeg preview and final export under `work/e2e-demo`.

See [V1.5 audit](docs/v1.5-audit.md), [benchmarks](docs/v1.5-benchmarks.md), [upstream research](docs/upstream-study.md), [architecture](docs/architecture.md), and [security](docs/security.md).
