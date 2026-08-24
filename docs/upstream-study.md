# Upstream study

Research date: 2026-08-24 (Asia/Shanghai)

This study is pinned to source commits, not README claims. Repositories were shallow-cloned into an untracked research cache and inspected for project/timeline schemas, transcript and speech pipelines, render paths, agent tools, history, persistence, and licenses.

## Decisions

- Build a domain-first runtime. Agents produce `EditingStrategy` and versioned `EditPlan` data; only the renderer translates a validated timeline into FFmpeg arguments.
- Represent all durable media time as integer microseconds. Provider adapters convert floating-point seconds at the boundary. Frame numbers remain derived values tied to an explicit rational frame rate.
- Preserve `rawText`, `normalizedText`, and `displayText`; normalization never overwrites ASR evidence.
- Run local speech engines as replaceable sidecars. The TypeScript core owns contracts, caching, persistence, workflow, and quality reports; Python runtimes own model inference.
- Use faster-whisper for the first local ASR provider. Treat alignment and diarization as optional capabilities, with WhisperX as an enhancement rather than a required core dependency.
- Use Kokoro behind `TTSProvider`; record code, model, voice, language, parameters, and license metadata per generated asset. Voice cloning is not a default capability.
- Use the official MCP TypeScript SDK and return validated `structuredContent`. Never expose raw shell or FFmpeg execution.
- Use FFmpeg for V1 preview/final render. Do not depend on Remotion in V1.
- Persist immutable versions and operation/diff provenance. UI-style undo stacks are useful references but are insufficient for durable agent history.

## Repository findings

### browser-use/video-use

- Commit: `92c2b34e44c205cbc2acae7f6ca7c1c219d5dd66` (2026-07-01)
- License: MIT.
- Inspected:
  - `helpers/transcribe.py`: word-level transcription artifact generation.
  - `helpers/pack_transcripts.py`: compact phrase-level LLM reading view.
  - `helpers/timeline_view.py`: selective visual/waveform inspection.
  - `helpers/render.py`: EDL-driven segment extraction, concat, overlays, subtitles, and preview rendering.
  - `SKILL.md`: proposal/approval/preview/self-check workflow and EDL contract.
- Reuse: workflow ideas, transcript packing, audio-first cut boundaries, preview self-check list.
- Architecture to reproduce: transcript-first inspection and a human approval gate before execution.
- Do not reuse as the core IR: its `edl.json` is deliberately small, project history is Markdown, rendering remains script-centric, and it has no durable state machine or semantic apply transaction.

### craftled/openklip

- Commit: `93dd0010cf9dec2c8a76cfb35a8346fcf52ed292` (2026-08-10)
- License: MIT.
- Inspected:
  - `src/projectStore.ts`, `src/projectMutations.ts`, `src/project-lock.ts`, `src/project-file-lock.ts`: filesystem persistence and concurrency.
  - `src/compiledTimeline.ts`, `src/headless-render.ts`: compiled timeline and headless render boundary.
  - `src/mcp-tool-surface.ts`, `src/mcp-server.ts`: MCP surface separated from core operations.
  - `web/lib/transcript-edit.ts`, `web/lib/transcript-diff.ts`: stable word IDs, deleted-word editing surface, text reconciliation.
  - `fixtures/moment-search/synthetic-project.json`: word timestamps represented as `startSec`/`endSec` with durable deletion flags.
  - history, revision, rebuild, and forward-compatibility tests under `tests/`.
- Reuse: architecture patterns for file locking, project revisions, transcript diffs, and a shared core behind UI/CLI/MCP.
- Do not copy its project shape wholesale: it is coupled to OpenKlip's product concepts and second-based floats.

### x777/frontstage

- Commit: `2358fc814822f7a55f9903bf595f0dca140c9d2e` (2026-07-06)
- License: GPL-3.0.
- Inspected:
  - `packages/core/src/timeline.ts` and `packages/core/src/clip.ts`: frame-based tracks/clips and timeline duration.
  - `packages/core/src/schema/schemas.ts`, `migrations.ts`, `serialize.ts`: schema evolution.
  - `packages/core/src/media/transcript.ts`: cached transcript records, word/segment filtering and offsetting.
  - `packages/ai/src/transcription/transcription-service.ts`: local/cloud cache and in-flight de-duplication.
  - `packages/ai/src/tools/types.ts`, `catalog.ts`: a common typed tool catalog with host capability injection.
  - `packages/core/src/editor/timeline-commands.ts`: command/reducer mutation boundary.
  - `packages/core/src/project/project-io.ts`: project I/O.
  - `apps/desktop/src/main/mcp/server.mjs`: MCP adapter.
- Reuse: none directly because GPL-3.0 is incompatible with the intended permissive runtime.
- Architecture to reproduce independently: capability injection, tolerant cached transcript parsing, timeline reducers, and schema migrations.
- Gap for this product: transcript words may have missing timestamps and provider types are closed unions; our contracts need explicit quality states and open provider metadata.

### Quriosity-agent/qcut

- Commit/version: `73b020b5dac7c45d2c5d7144832ea7c49b9ac984`, `v2026.08.24.1`.
- License: MIT (`qcut/LICENSE`).
- Inspected:
  - `qcut/apps/web/src/types/timeline.ts` and `qcut/packages/editor-core/src/types/timeline.ts`: multitrack element model.
  - `qcut/packages/editor-core/src/commands/history.ts` and tests: command history.
  - `qcut/apps/web/src/stores/timeline/timeline-history.ts`: grouped undo/redo transactions.
  - `qcut/electron/mcp/qcut-mcp-server.ts`: editor MCP bridge.
  - `qcut/resources/default-skills/native-cli/editor/*.md`: structured CLI, snapshot, batch, history, and capabilities surface.
  - `qcut/resources/default-skills/qcut-toolkit/videocut/talk-edit/SKILL.md`: word-level talking-head editing workflow.
- Reuse: CLI/MCP ergonomics and transaction grouping concepts.
- Do not adopt its complete editor model: it is a desktop NLE with a very large UI/runtime surface, whereas this project is a headless strategy/edit runtime.

### MartinDelophy/ai-video-editor

- Commit: `d4aa5d782b41d23b14536413a2b7530d4d53dff3` (2026-08-21)
- License: MIT.
- Inspected:
  - `src/lib/editorHistoryCore.ts`: bounded immutable snapshot undo/redo.
  - `src/hooks/useTimelineModel.js`: UI-derived visual/audio/caption lanes.
  - `src/lib/generatedVoicePlacement.js`: generated narration append placement.
  - `src/lib/kokoroVoiceRuntime.js`, `src/workers/hojoTts.worker.js`: local voice inference paths.
  - `skills/edit-timeline-studio/SKILL.md` and `scripts/timeline-command.mjs`: agent control surface.
- Reuse: small history and narration placement ideas.
- Do not adopt the UI-derived timeline or browser worker runtime as the durable project model.

### kingbootoshi/video-alchemy

- Commit: `3c7fd6bb3cac517e1989a419c172f204277454e7` (2026-07-27)
- License: MIT.
- Inspected:
  - `parakeet-transcribe/src/parakeet_transcribe/transcriber.py`: local ASR integration.
  - `parakeet-transcribe/src/parakeet_transcribe/formats/json_format.py`: transcript serialization.
  - `remotion-template/src/captions.json`: caption interchange.
- Reuse: provider-sidecar packaging reference.
- Do not adopt as the main architecture: it is a collection of media recipes/templates, not a recoverable edit runtime.

### WebDevBar/watch-video

- Commit: `a9ec4921c832de6f381b7f270b3e206345d01046` (2026-06-07)
- License: MIT.
- Inspected: shell implementation, transcription backends, timeline and transcription tests.
- Reuse: selective inspection commands and privacy/local-processing defaults.
- Do not reuse execution design: shell-oriented operations do not provide a stable Edit IR or transactional apply.

### egoist/ffmpeg-mcp

- Commit/version: `a9cacd56f6f1dc0ae63b9474d2751e6d942fc8e7`, `v0.0.3`.
- Declared package license: MIT (repository lacks a checked-in top-level license file at this commit; treat reuse as requiring clarification).
- Inspected `tools.ts` and `main.ts`: two Zod-described tools directly map user paths and parameters to `tinyexec(ffmpeg, args)`.
- Reuse: only the minimal stdio server wiring pattern.
- Rejected architecture: it is exactly the raw operation wrapper this project forbids; it lacks workspace path containment, project state, validation/diff/apply, and version provenance.

### Remotion

- Commit: `05075f384a0a28e193876c1fd43ab9fba5ef10f9` (2026-08-23).
- License: source-available tiered Remotion License. Free use is limited by entity type/size; larger for-profit organizations require a company license, and derivative resale restrictions apply.
- Inspected relevant render, media, caption, webcodecs, and renderer package paths plus the current license.
- Decision: no V1 dependency. Keep `Renderer` extensible so a separately licensed `RemotionRenderer` can be added later.

### SYSTRAN/faster-whisper

- Commit: `ed9a06cd89a93e47838f564998a6c09b655d7f43` (2025-11-19).
- Code license: MIT. Model weights retain their own upstream licenses and must be recorded per installed model.
- Inspected:
  - `faster_whisper/transcribe.py`: `Word`, `Segment`, `TranscriptionInfo`, VAD/word timestamp options, probabilities and language detection.
  - `faster_whisper/vad.py`: Silero VAD boundaries, padding, silence thresholds, and speech timestamp remapping.
  - tests for transcription and stereo diarization fixtures.
- Adopt: first local ASR sidecar. Map `Word.probability`, language probability, no-speech probability, and VAD regions into the core quality model.
- Limitation: no built-in speaker diarization/forced alignment contract; capability flags must remain false unless composed with another provider.

### m-bain/WhisperX

- Commit: `2cfd7b7c5c7bba144954364db747319b50e8232b` (2026-07-13).
- Code license: BSD-2-Clause.
- Inspected:
  - `whisperx/schema.py`: segment, word, character, aligned-result shapes.
  - `whisperx/alignment.py`: language-specific wav2vec2 models, CTC alignment, millisecond rounding, fallback paths.
  - `whisperx/diarize.py`: pyannote pipeline and overlap-based speaker assignment.
- Adopt as optional enhancement, not the baseline. Alignment and diarization model licenses/access terms vary independently (notably Hugging Face wav2vec2 and pyannote assets), so each installed model needs license metadata and an explicit capability report.
- Risk: model downloads, language coverage, NLTK assets, PyTorch footprint, Hugging Face token requirements, and diarization model terms complicate a default install.

### hexgrad/Kokoro

- Commit: `dfb907a02bba8152ca444717ca5d78747ccb4bec` (2025-08-06).
- Code/model license: Apache-2.0 for the inspected repository and canonical `hexgrad/Kokoro-82M` weights; voice/model provenance still must be persisted. G2P dependencies can have different licenses and must not be silently bundled.
- Inspected `kokoro/pipeline.py`:
  - language-specific G2P and chunking;
  - lazy voice loading/blending;
  - speed control;
  - predicted token durations and generated token timestamps;
  - 24 kHz output and phoneme-length limits.
- Adopt behind a local TTS sidecar. Persist the generated audio duration and provider token timestamps where available; otherwise run the alignment pipeline.
- Do not expose voice cloning. Stock voice selection and blending are not evidence of consented cloning.

### MCP TypeScript SDK

- Commit: `3924de99df834302d89f5997a1b64ca268282284` (2026-08-18).
- License: repository is transitioning from MIT to Apache-2.0; individual files retain applicable notices. Documentation is CC-BY-4.0.
- Inspected:
  - `examples/tools/server.ts`, `examples/server-quickstart/src/index.ts`: server registration.
  - `examples/schema-validators/server.ts`: `inputSchema`, `outputSchema`, runtime validation, and `structuredContent`.
  - `examples/streaming/server.ts`: progress/cancellation.
  - `packages/server/src/stdio.ts`: stdio transport boundary.
- Adopt official SDK. Each tool gets a narrow Zod input/output contract, machine-readable `structuredContent`, bounded text summaries, cancellation handling where supported, and domain-service delegation.

## Current agent integration mechanisms

### OpenAI Codex

Official OpenAI documentation states that skills are directories containing `SKILL.md` plus optional scripts/references, with name and description metadata. Codex initially sees skill metadata and loads full instructions on use. MCP is the external tool/context mechanism. Sources:

- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)

Implementation consequence: ship `skills/video-editing/SKILL.md` as workflow policy, while all project mutations remain MCP tools. The skill must never instruct Codex to edit durable project JSON directly.

### Claude Code

Current Claude Code documentation distinguishes MCP (external tools/data) from Skills (on-demand workflow knowledge), recommends using them together, supports project `.mcp.json`, and uses `.claude/skills/<name>/SKILL.md` or plugin-packaged skills. Tool schemas can be deferred through tool search. Sources:

- [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- [Connect Claude Code via MCP](https://code.claude.com/docs/en/mcp)
- [Extend Claude with skills](https://code.claude.com/docs/en/slash-commands)

Implementation consequence: stdio MCP is appropriate for the local MVP; document an equivalent project configuration for both Claude Code and Codex, and keep tool descriptions concise and outcome-oriented.

## License and distribution policy

- Product code should use a permissive license and only directly depend on permissively licensed libraries.
- GPL/frontstage is architecture-only reference; no copied code.
- Remotion is optional/future and must not be pulled into the default install.
- Every downloadable speech model and voice gets a manifest entry containing source URL, artifact hash, code license, weight/voice license, commercial-use status, attribution, and verification date.
- Unknown license means unavailable by default, not implicitly allowed.
- Voice cloning providers require an explicit capability plus consent metadata and usage restrictions.

## Resulting V1 dependency choices

- Runtime: Node.js/TypeScript.
- Validation: Zod.
- MCP: official TypeScript SDK over stdio.
- Render/probe: system FFmpeg/ffprobe via argument-array child processes with workspace containment.
- ASR: optional faster-whisper Python sidecar; fake provider is the test/default no-model path.
- Alignment/diarization: optional WhisperX sidecar, capability-gated.
- TTS: optional Kokoro Python sidecar, capability-gated; fake provider for tests.
- Persistence: atomic JSON files and immutable version snapshots in the project workspace; no database required for V1.
- Testing: Vitest, fake providers, and FFmpeg-independent contract tests.

