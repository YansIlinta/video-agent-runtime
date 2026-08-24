# V4 Native Mobile Proof — implementation report

Date: 2026-08-24

Status: **source-complete prototype; real-device definition of done is not yet met**.

## Outcome

The repository now contains a React Native 0.87 New Architecture shell, Codegen TurboModule contract, shared `createMobileHost()` composition root, durable mobile `ProjectRepository`, native Swift/Kotlin adapter sources, capability-gated native renderer, secure BYOK settings, ContextPack privacy accounting, network destination auditing, and restart recovery tests. The same `VideoAgentCore`, Workflow, EditPlan, Timeline, Version, Job, and provider contracts remain authoritative. No mobile-only product model or parallel queue was introduced.

## Platforms and native modules

- iOS source: Swift app-sandbox storage, Files picker, AVFoundation probe/export, Keychain, URLSession, BGTaskScheduler and CryptoKit, with the thin Objective-C++ glue required for a Swift TurboModule.
- Android source: Kotlin SAF/app-private storage, MediaMetadataRetriever, Media3 Transformer, AndroidKeyStore AES-GCM storage, HttpURLConnection and WorkManager.
- React Native: minimal Home, Provider Settings, Import, Project, Proposal, Preview, Jobs and Settings screens.

This Windows host has no Xcode, CocoaPods, Android SDK, ADB or Gradle. Neither native target was compiled, installed, or run on a simulator/device here.

Key additions:

- `apps/mobile/specs/NativeVideoHost.ts`: Codegen source of truth.
- `apps/mobile/ios/NativeVideoHost/NativeVideoHostService.swift`: iOS implementation.
- `apps/mobile/ios/NativeVideoHost/RCTNativeVideoHost.{h,mm}`: Objective-C++ adapter.
- `apps/mobile/android/.../NativeVideoHostModule.kt`: Android TurboModule.
- `apps/mobile/android/.../NativeMediaRenderer.kt`: Media3 renderer.
- `packages/mobile/src/*`: portable adapters, repository, facade, privacy and composition.

## Core changes

- `VideoAgentCore` accepts the injected host background adapter.
- Portable ASR normalization, cache keys, speech persistence, voice analysis, fusion and duration-fit services were separated from Node providers.
- Core edit helpers no longer import `node:crypto`; workflow and queue imports avoid Node host barrels.
- Preview self-check is injected; the Node factory retains FFmpeg self-check.
- `Renderer` has a truthful optional capability contract.
- Normalized errors include provider auth, insufficient storage, unsupported codec and background interruption.

## Media capability matrix

| Operation | iOS source | Android source | Device verified |
|---|---:|---:|---:|
| controlled import | yes | yes | no |
| native metadata probe | yes | yes | no |
| trim / concat | yes | yes | no |
| scale to timeline geometry | AVMutableVideoComposition | Media3 `Presentation` (SCALE_TO_FIT) | no |
| ranged preview | yes | yes | no |
| preserve source audio | yes | yes | no |
| preview / final export | yes | yes | no |
| crop | no | no | no |
| speed | no | no | no |
| caption burn-in | no | no | no |
| ducking / overlay | no | no | no |

`NativeMobileRenderer` rejects unsupported operations before native execution; it does not claim FFmpeg parity.

Output geometry and range selection are decided in `packages/mobile/src/render-plan.ts`, not in the native renderers: final output matches the timeline, preview scales down to the device's `previewMaxWidth` preserving aspect ratio, and a ranged preview is trimmed and rebased before it crosses the bridge. Neither renderer crops — content is fitted, never discarded.

## Transcription

There is none on this host. `UnavailableASRProvider` throws rather than returning a fixture, so an edit cannot be proposed on device until a real ASR provider is configured. See [local-models.md](local-models.md).

## Secure BYOK and provider behavior

- Project JSON and provider config contain only `credentialRef`.
- iOS uses Keychain with `AfterFirstUnlockThisDeviceOnly`.
- Android uses an AndroidKeyStore AES key and AES-GCM encrypted private preferences.
- Contract tests prove the secret is absent from durable JSON.
- The portable OpenAI Responses provider uses native HTTP, model selection and reasoning selection.

A real credential was not supplied, so live connection, structured generation, model availability and reasoning behavior were not run. Official OpenAI documentation says keys must not be exposed in client-side apps; direct device BYOK is therefore a constrained prototype, not a recommended production architecture.

## Background and restart

- iOS schedules BGProcessingTask requests and records pending identifiers. Indefinite background export is not claimed.
- Android uses WorkManager wake-ups. A foreground service is deferred until a real export and notification flow justify it.
- Mobile composition calls `DurableJobQueue.recover()`. A persisted `running` job becomes `queued/recovered` with retry history.
- Reconstructed-host contract recovery passed; actual OS termination during export is untested.

## Zero-server and privacy evidence

- `apps/mobile` contains no app backend, proxy or API server.
- Network audit records only provider host, method, request class and time—not secrets or content.
- ContextPack requires explicit approval, removes local URIs, forces raw-media bytes to zero for the implemented flow, and records categories, text bytes, frames and remote-media bytes.
- Contract evidence: `frames = 0`, `remoteMediaBytes = 0`; raw media excluded.

## Verification

Passed on Windows / Node 24:

- `npm run typecheck` and `npm run build` — these cover `packages/**`, `apps/cli` and `tests`. They **exclude `apps/mobile`**, which cannot compile under `module: NodeNext`.
- `npm run typecheck:mobile` — the React Native surface (`App.tsx`, `specs/`, `src/`) and everything it imports, under the React Native TypeScript config. Run `npm run mobile:install` first. This check did not exist before 2026-08-24 and was clean on its first green run only after four defects it exposed were fixed; see [known-issues.md](known-issues.md) items 1a–1d.
- `npm test -- --maxWorkers=1`: 13 files, 36/36 tests
- `npm run smoke:mcp`: 59 tools; project create and system status passed
- `npm run cli -- doctor`: ready; FFmpeg 6.0 available
- `npm run demo`: transcript → strategy → plan → versions → previews → feedback patch → final FFmpeg export passed
- Native mobile contract tests: 4/4 passed

The Node FFmpeg E2E produced three self-checked previews and a final export. Observed timings were about 485 ms ASR fixture normalization, 2306 ms first preview and 1855 ms final export. These are **not mobile benchmarks**.

Skipped due to unavailable tools/device:

- Codegen (requires the generated app shells)
- Xcode/CocoaPods and Android Gradle compilation
- simulator/emulator and physical-device smoke
- live BYOK request
- mobile memory, thermal, battery, disk and output-size measurements

## Remaining gaps

iOS: run Codegen, verify generated selectors, register BGTask expiration handling, and test picker lifetime, transforms, orientation, codecs and export presets on a real iPhone.

Android: generate the RN shell, merge pinned Media3/WorkManager dependencies, compile, verify current Transformer APIs, test `content://` permission loss, low storage and WorkManager interruption, and add a foreground service only when justified.

Both: caption burn-in remains unsupported; mobile performance and background behavior require real-device evidence.

## Next local ASR milestone

Keep `ASRProvider`. Evaluate whisper.cpp, Core ML Whisper variants, ONNX/mobile runtimes and Android-native inference on hardware. Record latency, memory, thermals, battery, model size and word timestamp quality. Do not start local TTS or voice cloning until native host compilation and restart/export pass.

## Claim boundary

This is not production readiness and not the completed real-device milestone. It is a source-level native host prototype with portable contract evidence and a green Node runtime. Completion requires native compilation and the documented real-device measurement pass.
