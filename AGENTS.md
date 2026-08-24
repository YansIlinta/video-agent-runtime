# Repository rules for coding agents

This repository is developed with coding agents, but the agent is not the product architecture. Before changing code, preserve the runtime invariants below.

## Start with the narrowest relevant context

Read only what the task needs:

- Product behavior and public positioning: [`README.md`](README.md)
- Day-to-day engineering setup: [`docs/development.md`](docs/development.md)
- Domain/runtime architecture: [`docs/architecture.md`](docs/architecture.md)
- Security and secret handling: [`docs/security.md`](docs/security.md)
- Speech models and provider choices: [`docs/speech-models-2026.md`](docs/speech-models-2026.md)
- Voice identity / cloning / design: [`docs/voice-identity.md`](docs/voice-identity.md)
- Mobile host: [`docs/mobile/README.md`](docs/mobile/README.md)
- Agent-facing video-editing workflow: [`skills/video-editing/SKILL.md`](skills/video-editing/SKILL.md)

Do not load every document for every task.

## Authoritative architecture

The following shared domain/runtime concepts remain authoritative across CLI, MCP, Control API, Node and Mobile hosts:

```text
VideoAgentCore
Project / ProjectRepository
Workflow
Transcript
EditingStrategy
EditPlan
EditPatch
Timeline
Version
Job / JobEvent
ProviderCall
Provider contracts
Renderer contracts
```

Do **not** introduce:

- a mobile-only editing domain;
- a second Timeline model;
- a second Workflow state machine for the same project flow;
- a second durable Job Queue;
- transport-specific project mutation logic;
- a provider-specific branch inside core domain logic when capability discovery can express the difference.

A lightweight transport such as `speech-mcp` may avoid constructing the full project runtime, but it should reuse shared provider/runtime contracts instead of cloning implementations.

## LLM and edit-state rules

LLM output is proposal data, not authoritative project state.

The expected direction is:

```text
LLM
→ structured schema
→ validation
→ semantic validation
→ diff
→ apply
→ immutable Version
→ render
```

Never replace that with:

```text
LLM
→ raw shell / FFmpeg command
→ execute
```

Agents and MCP handlers must not edit durable project JSON directly.

## Provider rules

Provider capability declarations must describe what the adapter actually implements, not everything the upstream model advertises.

Examples:

- a provider that buffers a complete WAV is not `streaming=true`;
- a renderer that only scales/fits is not `crop=true`;
- a transcription result without timestamped segments is not edit-safe ASR;
- Voice Design, preset TTS, Voice Clone and Voice Conversion are separate capabilities.

Prefer capability-driven behavior over checks such as:

```ts
if (provider.id === "qwen") { ... }
```

If a capability cannot be provided, fail explicitly rather than silently degrading the edit result.

## Speech and voice

ASR is part of the semantic timeline, not merely subtitle generation.

TTS output becomes an explicit SpeechAsset / project asset / Timeline clip; do not hide generated speech inside opaque renderer commands.

Voice cloning requires explicit authorization. Do not:

- automatically clone a detected speaker;
- infer consent from an uploaded file;
- add public-figure or clone-from-URL shortcuts;
- silently fall back from transcript-backed high-quality cloning to embedding-only cloning.

Embedding-only enrollment must remain an explicit opt-in when supported.

## Performance rules

Optimize measured work, not the number of interfaces.

Avoid introducing or reintroducing:

- whole-file reads for multi-GB media where streaming is available;
- Base64 / `number[]` transport of large media across the React Native bridge;
- full durable-directory rescans in hot scheduler paths;
- unbounded in-memory provider/job metadata;
- always-resident local speech models when they are not used;
- duplicate copies of provider/model runtimes for different transports.

Do not remove durability merely to reduce class count. Project versions, job persistence, transactional apply/recovery and authorization provenance exist for correctness.

## Platform boundaries

Core/domain packages must stay portable.

Node-specific behavior belongs behind Node adapters:

- `node:fs`
- `child_process`
- process environment
- FFmpeg CLI
- Python sidecars

Mobile-specific behavior belongs behind mobile/native adapters:

- React Native TurboModules
- Swift / AVFoundation / Keychain / BGTaskScheduler
- Kotlin / Media3 / AndroidKeyStore / WorkManager
- platform asset handles / `content://` / picker URLs

The core should learn about platform differences through injected capabilities, not imports from host implementations.

## Security rules

Never persist secrets in:

- project JSON;
- Timeline / Version state;
- ProviderCall records;
- JobEvent records;
- benchmark reports;
- normal logs;
- MCP output.

Persist credential references only. API keys belong in environment variables or platform secure storage.

Do not expose arbitrary filesystem paths, shell execution or unrestricted media-upload destinations to an agent.

## Testing expectations

For ordinary Node/runtime changes, run:

```sh
npm run typecheck
npm test
npm run build
```

For MCP changes:

```sh
npm run smoke:mcp
npm run smoke:speech-mcp
```

For mobile TypeScript/bridge contract changes:

```sh
npm --prefix apps/mobile ci
npm run typecheck:mobile
```

Do not claim real local-model or hosted-model success from fake-provider CI. Use:

```sh
VIDEO_AGENT_REAL_ACCEPTANCE=true npm run eval:speech-real
```

and aggregate repeated measurements with:

```sh
npm run benchmark:speech-summary
```

## Claim boundaries

Be precise in code comments, docs, PRs and summaries.

These are different claims:

- source implemented;
- typechecked;
- unit/contract tested;
- integration tested;
- native compiled;
- simulator/emulator tested;
- physical-device tested;
- measured on a named machine/device.

If a measurement was not made, write `not measured` / `not verified`. Do not fill missing evidence with estimates.

## Documentation hygiene

- Root `README.md` is the product home.
- `docs/README.md` is the technical index.
- `docs/development.md` is the engineering setup/reference.
- Topic documents describe current technical truth.
- `docs/releases/` contains historical/version-stamped reports.
- Update the README only for user-visible/product-level changes; avoid turning it back into a dump of implementation notes.

When a new provider, public command or runtime surface is added, update the nearest relevant documentation in the same change.
