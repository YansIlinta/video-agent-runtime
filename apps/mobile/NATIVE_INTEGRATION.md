# Native mobile integration status

This directory is a React Native New Architecture prototype, not a published app. The TypeScript specs in `specs/` are the authoritative Codegen surface.

## iOS integration

The iOS native services and Objective-C++ Codegen glue are checked in, but the repository does not yet contain a complete Xcode/CocoaPods application host. iOS native compilation and device execution are therefore still unverified.

1. Add the React Native 0.87 iOS application shell and include the files in `ios/NativeVideoHost` in the application target.
2. Set the bridging header to `NativeVideoHost/NativeVideoHost-Bridging-Header.h`.
3. Add `BGTaskSchedulerPermittedIdentifiers` with `com.videoagent.mobile.processing`, and register its handler during application launch. The handler must wake the JS runtime, call `DurableJobQueue.recover()`, and always call `setTaskCompleted(success:)` before expiration.
4. Add a background-processing capability only after testing the expiration path. AVAsset export is not claimed to run indefinitely in the background.
5. Run `bundle exec pod install`; React Native Codegen generates the native spec glue used by the Objective-C++ wrappers.

The Swift implementation uses app-controlled storage for imported media. A security-scoped picker URL is only a temporary source for `copySourceAsset`; it is never written into Project identity.

## Android integration

The Android application host is checked in and compiled in CI. The native gate uses React Native 0.87, Gradle 9.4.1, Kotlin 2.2, stable Android API 36/build-tools 36, and NDK 27.1.12297006. CI runs `assembleDebug` for x86_64; that task executes React Native Codegen before compiling the Kotlin/Java/native dependency graph.

- `MainApplication.kt` manually registers `NativeVideoHostPackage()` so both custom TurboModules are available to the React runtime.
- `MainActivity.kt` mounts the existing `VideoAgentMobile` JS component.
- `npm run codegen:android` remains available as an isolated diagnostic command, while `npm run build:android` is the authoritative compile gate.
- `VideoAgentWorker` is registered through WorkManager. Work is tagged with both `NativeVideoHostModule.WORK_TAG` and the job id, which is what `pendingBackground()` reads back.
- To make a background wake-up actually resume JS work, a `HeadlessJsTaskService` and matching `AppRegistry.registerHeadlessTask` recovery handler are still required. Until that exists, `VideoAgentWorker` only completes; durable recovery happens on the next foreground launch.
- A foreground service is intentionally not enabled until a real export exceeds ordinary WorkManager constraints and the notification UX is implemented.

The picker uses `ACTION_OPEN_DOCUMENT`/SAF. `content://` is accepted only at the import boundary and copied into app-private project storage before Core sees the asset.

## Capability truth

| Operation | iOS AVFoundation | Android Media3 |
|---|---:|---:|
| trim | implemented in source; compile/device verification pending | implemented and compiler-verified; device verification pending |
| concat | implemented in source; compile/device verification pending | implemented and compiler-verified; device verification pending |
| crop/scale | export preset / aspect normalization; compile/device verification pending | Media3 Presentation effect; compiler-verified, device verification pending |
| preserve audio | implemented in source; compile/device verification pending | implemented and compiler-verified; device verification pending |
| speed | unsupported | unsupported |
| caption burn-in | unsupported | unsupported |
| audio ducking | unsupported | unsupported |
| overlay | unsupported | unsupported |
| background export | false | WorkManager wake-up compiled; long export/device verification pending |

Unsupported operations are rejected by `NativeMobileRenderer` before native execution. Compiler verification means the checked-in host, Codegen output, Kotlin/Java sources, Android resources, and declared native dependencies successfully produce a debug APK in CI; it does not imply runtime/device behavior has been measured.

## Required device smoke

Use a 1–5 minute talking-head video, complete the two-prompt flow in the milestone, then capture device model, OS, import/probe/render timings, peak memory, temporary disk usage, output size, thermal state, provider host, ContextPack byte counts, restart outcome, and exported video playback. Until that evidence exists, do not claim the milestone definition of done or production readiness.
