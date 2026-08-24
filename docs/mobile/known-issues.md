# Known issues — native mobile host

Source review of the 0.4.0 tree, 2026-08-24, followed by a fix pass the same day.

Nothing here was found by running the app: [neither native target has been compiled](native-host-status.md). Items marked **fixed** were fixed in source and, where a check exists on this host, verified by running it. Items marked **fixed (unverified)** touch Swift or Kotlin, which cannot be compiled here — they are reasoned corrections, not proven ones.

Severity: **P0** breaks a flow outright · **P1** runs but does the wrong thing · **P2** design or hygiene.

## P0

| # | Issue | Location | Status |
| --- | --- | --- | --- |
| 1 | **The mobile surface was never checked by any tool.** The root tsconfig excludes `apps/mobile` (correctly — it cannot compile under `module: NodeNext`), but nothing else checked it either. | `tsconfig.json:20` | **fixed** — added `npm run mobile:install` and `npm run typecheck:mobile`. See items 1a–1d for what running it immediately exposed. |
| 1a | **`apps/mobile` could not be installed at all.** `react-native@0.87.0` requires peer `react@^19.2.3`; the manifest pinned `react@19.2.0`, so `npm install` failed with `ERESOLVE`. | `apps/mobile/package.json` | **fixed** — `react` is now `^19.2.3`; install succeeds. |
| 1b | **The mobile tsconfig `extends` target could never resolve.** `@react-native/typescript-config` exposes only `"."` in its `exports` map, so the subpath `.../tsconfig.json` is not resolvable and the base config was silently ignored. | `apps/mobile/tsconfig.json:2` | **fixed** — extends the package entry point. |
| 1c | **Inherited compiler settings were wrong for this repo.** With the base config finally applied, RN's `lib` list lacks ES2023 and its `types: ["jest"]` requires a package that is not installed. | `apps/mobile/tsconfig.json` | **fixed** — `lib: ["ES2023", "DOM"]`, `types: []`. |
| 1d | **Node-only modules leaked into the mobile compilation graph.** `video-agent-core.ts` imported types from the providers barrel and the core barrel; those barrels re-export `fakes`, `openai-voice`, `registry` → `node-host`, and `project-store`, which import `node:fs`, `node:crypto`, `node:path`, `Buffer` and `process`. 57 type errors, and a Metro bundling hazard beyond that. | `video-agent-core.ts:10,24,25,66`, `providers/src/contracts.ts:1` | **fixed** — those imports now name the specific contract/schema modules. `npm run typecheck:mobile` is clean. |
| 2 | **iOS security-scoped access was released before the copy.** `if url.startAccessingSecurityScopedResource() { defer { stop() } }` — `defer` is scoped to the `if` block and fired before `copyItem`. | `NativeVideoHostService.swift:36` | **fixed (unverified)** — replaced by a `withAccess(_:_:)` helper that holds access for the whole operation. |
| 3 | **iOS import failed one step earlier still.** `copySourceAsset` calls `stat(sourceUri)` before copying, and `statJSON` went straight to `attributesOfItem` with no security scope. The deeper cause: a URL rebuilt from a string does not carry the picker's scope, and the JS boundary only carries strings. | `NativeVideoHostService.swift:34`, `project-repository.ts:77` | **fixed (unverified)** — the picker now retains the original URL objects in `pickedSources`; `statJSON` and `copy` resolve through them and hold access. Same-session only; cross-session re-import still needs a persisted bookmark. |
| 4 | **iOS HTTP timeout was off by 1000×.** The `/1000` divisor applied only to the default branch, so a caller-supplied `120_000` became a 120,000-second timeout. | `NativeVideoHostService.swift:54` | **fixed (unverified)** |
| 5 | **Android background recovery was inert.** Work was tagged with `task.id` while `pendingBackgroundJson` queried the tag `"video-agent"`, so it always returned empty. | `NativeVideoHostModule.kt:80,82` | **fixed (unverified)** — a `WORK_TAG` constant is applied alongside the job id, and the job id is read back from the tags. |
| 5b | **The WorkManager wake-up does not resume anything.** A `CoroutineWorker` cannot start the React Native runtime on its own. | `VideoAgentWorker.kt` | **not fixed** — requires a `HeadlessJsTaskService`, a manifest entry and a registered JS headless task; the app shell that would hold them does not exist yet. The code and `NATIVE_INTEGRATION.md` now say so instead of implying a working wake-up. |
| 6 | **Android SAF permission was never persisted.** The `ACTION_OPEN_DOCUMENT` intent omitted `FLAG_GRANT_PERSISTABLE_URI_PERMISSION`, so `takePersistableUriPermission` threw into a `runCatching`. | `NativeVideoHostModule.kt:64` | **fixed (unverified)** |

## P1 — open

| # | Issue | Location |
| --- | --- | --- |
| 7 | **Both renderers hardcode 1280×720 and ignore the timeline and the render mode.** Projects are created at 1080×1920; Android additionally applies `LAYOUT_SCALE_TO_FIT_WITH_CROP`, cropping portrait source to landscape. Final export is capped at 720p. The documented "crop/scale" capability is not driven by the timeline at all. | `NativeMediaRenderer.kt:30`, `NativeVideoHostService.swift:50` |
| 8 | **`rangeJson` is ignored on both platforms**, so a ranged preview renders the whole timeline. | same as above |
| 9 | **Mobile preview self-check always reports failure.** Mobile injects no `previewSelfCheck`, so Core falls back to `warnings.length === 0`, and both renderers unconditionally append a boilerplate warning. Mobile has no self-check and permanently reports one as failed. | `video-agent-core.ts:371` |
| 10 | **The caption-burn-in gate treats a tri-state as a boolean.** `!capabilities.captionBurnIn` lets the truthy `"partial"` through, and the default capability object uses exactly that value. Not currently reachable because both hosts report `false`. | `packages/mobile/src/renderer.ts:9,18` |
| 11 | **Two privacy modes are dead options.** `buildMobileContextPack` forces `includeRawMedia:false` and `includeLocalUris:false` regardless of mode, so `allow-remote-media` and `text-and-derived-visuals` do nothing. The `frames: 0` / `remoteMediaBytes: 0` "evidence" is a hardcoded literal and the contract test asserts that literal. | `packages/mobile/src/privacy.ts:11,12` |
| 12 | **On-device transcription is a fixture.** `FixtureASRProvider.transcribe` ignores the audio URI and returns fixed text. Every downstream strategy, plan and cut on mobile is computed against invented content. | `packages/mobile/src/composition.ts:15` |
| 13 | **The bridge cannot carry a real ASR request even if one were wired.** HTTP bodies are typed `string` only, and the adapter runs `TextDecoder().decode()` over any `Uint8Array` — binary uploads are silently corrupted rather than rejected. | `native-bridge.ts:52`, `adapters.ts:41` |

## P2 — open

- `native-bridge.ts:30` states "Binary-heavy media never crosses JS", but `read(uri)` returns a whole file as `number[]` and HTTP response bodies take the same path.
- iOS never calls `emitOnProgress`, and the JS bridge never subscribes to `onProgress`. The entire event surface is inert.
- `RCTNativeVideoHost.mm:33` hardcodes `backgroundBudgetMs` to 25000, bypassing the Swift implementation.
- Permissions are stubs: Android returns `granted` unconditionally for files/photos; iOS queries `PHPhotoLibrary` although the picker is `UIDocumentPicker`, which needs no photo permission. The Settings screen promises behavior that is not implemented.
- Compile risks to check on the first real build: `.mm` has no `RCT_EXPORT_MODULE()`; no-argument `await session.export()` is not a current AVFoundation API; `EditedMediaItemSequence.Builder(List)` needs checking against Media3 1.8.0.
- `apps/mobile` contains no Xcode project, Podfile, `build.gradle`, `settings.gradle`, `AndroidManifest.xml` or `MainApplication.kt`. `NATIVE_INTEGRATION.md` describes generating them, which is accurate; "React Native shell" elsewhere overstates what is present.
- `apps/mobile/package.json` still pins `@react-native-community/cli` to `"latest"`. The two packages versioned in lockstep with `react-native` are now pinned; the CLI is versioned independently and was left alone rather than guessed at.
- `renderer.ts:21` uses `Date.now()` and `network-audit.ts:7` uses `new Date()`, bypassing the injected clock/id adapters the rest of the composition uses.
- `composition.ts:67` sets `maxUploadBytes` to 5 GB, which is not a sensible device limit.

## Repo-level, found while verifying

- **`npm test` is flaky under parallel workers.** `tests/voice-infrastructure.test.ts > propagates cancellation and classifies transient and permanent voice job failures` took 13,685 ms against the 15,000 ms `testTimeout` and failed; the same suite passes 36/36 with `--maxWorkers=1` in 8.4 s total. Reports have been quoting the serial command. Either the timeout or the test's contention behavior should be addressed rather than papered over with a worker pin.
- `packages/mcp/src/server.ts:9` advertises `version: "0.2.0"` while `package.json` is `0.4.0`.
