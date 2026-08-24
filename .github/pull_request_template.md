## Problem

What problem does this PR solve?

## Scope

Which boundary is touched?

- [ ] Core domain / workflow / timeline
- [ ] Provider (ASR / LLM / TTS / voice)
- [ ] Renderer / media
- [ ] Jobs / persistence / recovery
- [ ] Project MCP / Speech MCP / CLI / Control API
- [ ] Mobile host / native bridge
- [ ] Evaluation / benchmarks
- [ ] Documentation only

## What changed

Describe the implementation and why this is the smallest appropriate change.

## Architectural invariants

Confirm the relevant invariants remain true:

- [ ] No second Project / Timeline / Workflow / Job model was introduced.
- [ ] Public surfaces still reuse shared provider/runtime contracts.
- [ ] Provider capability flags describe implemented adapter behavior.
- [ ] Models still propose structured changes; runtime owns mutation/persistence/rendering.
- [ ] Large media is not unnecessarily copied into JS/base64/whole-file memory.
- [ ] Secrets are not written into durable project state, logs, MCP output, or benchmark reports.
- [ ] Voice identity changes preserve explicit authorization/provenance requirements.

If any box does not apply, explain why below rather than checking it blindly.

## Verification

Deterministic checks run:

- [ ] `npm run typecheck`
- [ ] `npm test -- --maxWorkers=1`
- [ ] `npm run build`
- [ ] `npm run smoke:mcp` (when project MCP is affected)
- [ ] `npm run smoke:speech-mcp` (when speech MCP/providers are affected)
- [ ] `npm run typecheck:mobile` (when shared/mobile contracts are affected)
- [ ] `npm run demo` (when editing/rendering behavior is affected)

Real-provider / heavyweight checks:

- [ ] `npm run eval:speech-real`
- [ ] `npm run benchmark:speech-summary`
- [ ] Native iOS compile / simulator
- [ ] Native Android compile / emulator
- [ ] Physical-device test

List anything skipped and why. Do not convert a skipped check into a support/performance claim.

## Performance / resource impact

If this touches a hot path, large media, local models, background jobs, or mobile code, describe expected memory/I/O/process/network impact and any measured evidence.

## Security / privacy impact

Does this change filesystem access, outbound network destinations, provider credentials, voice reference handling, native upload, or agent-visible data? If yes, describe the boundary and tests.

## Claim boundary

What can this PR truthfully claim after merge?

For example: source implemented, typechecked, deterministic E2E verified, hosted-provider verified, local-model measured, native compiled, or physical-device measured.

## Remaining limitations

What is intentionally not solved by this PR?
