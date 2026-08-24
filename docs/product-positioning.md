# Product positioning

This note keeps the public project story aligned with the runtime that actually exists.

## One sentence

**Video Agent Runtime is an agent-native, headless video editing engine that turns model intent into validated, versioned timeline changes and deterministic renders.**

## What the product is

- A structured video-editing runtime for agents.
- A durable Project / Transcript / EditingStrategy / EditPlan / EditPatch / Timeline / Version model.
- A review-and-approval workflow around model-generated edits.
- A shared core exposed through CLI, full project MCP, lightweight speech MCP, Control API and a mobile host prototype.
- A local-first media system where remote models receive constrained context/evidence rather than arbitrary project filesystem access.
- A speech-aware editor with ASR, narration, TTS, authorized voice identity and dubbing represented as project/timeline data.

## What the product is not

- A desktop non-linear editor clone.
- A wrapper that asks an LLM to write arbitrary FFmpeg commands.
- A cloud project service that requires the repository owner to operate a backend.
- A promise that every researched ASR/TTS model is implemented.
- An automatic voice-cloning tool for arbitrary detected speakers.
- A claim that the current mobile source prototype has passed native device validation.

## Public wording hierarchy

Use these terms consistently:

1. **Video Agent Runtime** — the product/project.
2. **VideoAgentCore** — the authoritative application/runtime composition.
3. **Project MCP** — the full project-scoped MCP surface.
4. **Speech MCP** — the intentionally lightweight ASR → structured LLM → TTS surface.
5. **Mobile Host** — a host implementation of the same core contracts; currently a source-level native prototype.
6. **Provider** — an adapter that implements a capability contract; upstream model features are not automatically provider capabilities.

## Claim boundaries

A README or release note should distinguish:

- implemented source,
- CI/typechecked behavior,
- deterministic or FFmpeg E2E behavior,
- credential-gated hosted-provider behavior,
- real local-model measurements,
- native mobile compilation/device measurements.

Do not collapse these into a generic “supported” claim when only one layer has been verified.

## README role

The repository root README is the product home. It should answer, in order:

1. What is this?
2. What does a user/agent workflow look like?
3. What can it do today?
4. Which speech/model paths exist?
5. How do I run or connect it?
6. How do I validate real providers?
7. What is the mobile story and its current boundary?
8. Where are the technical docs?

Detailed implementation discussion belongs in `docs/`; historical evidence belongs in `docs/releases/`.
