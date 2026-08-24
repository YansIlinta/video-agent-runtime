# Mobile Host Migration Guide

V3 is additive. Existing schema version 1 projects remain readable. `Asset.relativePath` remains required for V1/V2 Node projects; new imports also write `Asset.ref` with a `project://` logical URI. No existing EditPlan/EditPatch/Timeline/Version/Job shape was removed.

Node CLI, MCP, API, FFmpeg and Python providers remain Node-host composition features. The domain runtime now receives a `ProjectRepository`, runtime primitives and provider/media boundaries.

## Host implementation order

1. Implement filesystem, secure storage, HTTP, clock/ID/crypto and capabilities.
2. Implement `ProjectRepository` with atomic record writes and schema validation.
3. Map legacy `relativePath` to `project://<projectId>/<relativePath>` on read; write both fields during transition.
4. Implement media probing/rendering and asset materialization; never persist platform paths.
5. Implement background scheduling with persisted Jobs as authority and idempotent restart recovery.
6. Add ASR/TTS native providers that report real timestamp/alignment/diarization/cloning capabilities.
7. Expose only a narrow UI facade of commands, queries and events.

Convert plaintext configuration to `ProviderConfig` plus secure storage. Node environment variables can become references such as `env://OPENAI_API_KEY`; mobile input becomes an opaque Keychain/Keystore reference. Never migrate secret values into project JSON.

Node keeps FFmpeg. iOS targets AVFoundation; Android targets Media3/MediaCodec. Preview resolution and concurrency come from resource budgets, and serious/critical thermal state must reduce or pause optional work.

