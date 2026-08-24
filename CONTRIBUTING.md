# Contributing

Thanks for contributing to Video Agent Runtime.

This repository is intentionally conservative about architecture changes because several public surfaces — CLI, project MCP, speech MCP, Control API, and the mobile host — share the same runtime and domain contracts.

Before making a change, read:

- [`README.md`](README.md) for product scope.
- [`docs/development.md`](docs/development.md) for setup, commands, package boundaries, and testing.
- [`AGENTS.md`](AGENTS.md) if you are using Claude Code, Codex, or another coding agent.
- [`docs/architecture.md`](docs/architecture.md) for the authoritative runtime flow.

## What belongs here

Good contributions usually improve one of these areas:

- durable project / timeline correctness,
- agent or MCP ergonomics,
- structured edit planning and validation,
- ASR / TTS / voice provider quality,
- rendering correctness and performance,
- crash recovery and cancellation,
- privacy / security boundaries,
- real-provider and real-device measurement,
- mobile host portability,
- documentation and examples.

This project is not trying to become a desktop NLE clone or an arbitrary FFmpeg/shell wrapper.

## Architectural guardrails

Please preserve these invariants:

1. `VideoAgentCore` remains the authoritative application/runtime composition.
2. `Project`, `Transcript`, `EditingStrategy`, `EditPlan`, `EditPatch`, `Timeline`, `Version`, `Job`, and provider contracts remain shared across hosts.
3. Do not introduce a second timeline model, project model, queue, workflow engine, or provider runtime for one surface.
4. Models propose structured changes; the runtime validates, persists, applies, renders, versions, and recovers them.
5. Provider capabilities must describe the adapter that is actually implemented, not every feature advertised by an upstream model.
6. Large media should not be copied through JS/base64 or loaded into memory when a streaming/file-backed path exists.
7. Secrets never belong in project JSON, ProviderCall persistence, logs, benchmark reports, or MCP output.
8. Voice cloning requires explicit authorization and provenance. Do not add automatic clone-from-upload, clone-from-URL, or public-figure shortcuts.

See [`AGENTS.md`](AGENTS.md) for the fuller repository rules.

## Development setup

Requirements:

- Node.js 22+
- FFmpeg / FFprobe for real media rendering
- optional Python environment for local ASR/TTS providers

Install and verify:

```sh
npm install
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npm run smoke:speech-mcp
npm run smoke:mcp
```

The mobile package is a separate compilation unit:

```sh
npm run mobile:install
npm run typecheck:mobile
```

For a full local editing smoke:

```sh
npm run demo
```

Do not turn credential-gated or heavyweight model runs into mandatory CI dependencies.

## Provider changes

When adding or changing an ASR, LLM, TTS, or voice provider:

- keep the existing provider contract unless a real cross-provider capability is missing,
- add capability-level tests,
- preserve AbortSignal cancellation,
- bound retries and output sizes,
- keep raw provider formats below the normalization boundary,
- avoid loading large models during normal runtime construction,
- prefer file-backed or streaming binary I/O for large media,
- document code-license, model-weight, and hosted-API term differences where relevant.

A researched model does not need an adapter just to increase provider count. Prefer a small maintained set of real runtime paths.

## Speech and voice changes

ASR used for editing must expose usable time information. Pure text without timestamped segments must not silently enter the canonical editing Transcript.

Generated speech must become explicit project/timeline state rather than an opaque renderer side effect.

For voice identity changes:

- preserve authorization status,
- preserve source/reference provenance,
- do not silently fall back from transcript-backed high-quality enrollment to embedding-only enrollment,
- require explicit speaker selection for ambiguous multi-speaker material,
- retain deletion and revocation semantics.

## Mobile changes

The mobile host must remain an injected host implementation of the same core contracts.

Do not create mobile-only domain models or a second queue/workflow.

Treat source-level implementation, native compilation, simulator testing, physical-device testing, and measured device performance as different verification levels. Documentation must say which level was actually reached.

## Performance changes

Optimize measured costs, not interface count.

High-value targets include:

- whole-file reads of large media,
- repeated full-directory scans,
- unbounded caches,
- binary data crossing the React Native bridge,
- unnecessary JSON serialization/copies,
- unnecessary process/model startup,
- scheduler work that scales with total historical jobs rather than active work.

Do not remove durable/versioned state merely to make a microbenchmark look smaller.

## Tests and claim boundaries

Normal pull requests should pass the applicable deterministic checks.

If a change claims real provider/model behavior, use the opt-in acceptance harness:

```sh
VIDEO_AGENT_REAL_ACCEPTANCE=true npm run eval:speech-real
npm run benchmark:speech-summary
```

If you do not have the required model, API key, native SDK, simulator, or physical device, say that explicitly in the PR. A skipped check is not a failure, but it is also not evidence that the path works.

Never turn desktop Node timings into mobile benchmark claims.

## Pull requests

Keep PRs focused. A useful PR description should state:

- the problem being solved,
- the architectural boundary touched,
- what changed,
- what deliberately did not change,
- tests that passed,
- tests that were skipped and why,
- real-model/device evidence if the PR makes those claims,
- remaining limitations.

Prefer separate PRs for unrelated runtime, provider, mobile-native, and documentation work.

## Documentation

Use the repository hierarchy consistently:

- root `README.md` — product home,
- `docs/README.md` — technical documentation index,
- `docs/development.md` — developer setup and engineering workflow,
- `docs/releases/` — historical/version-stamped evidence,
- `CHANGELOG.md` — concise release history,
- `AGENTS.md` — coding-agent repository guardrails.

Documentation should distinguish implemented source, CI-verified behavior, real-provider measurements, and real-device measurements.
