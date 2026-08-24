# Native mobile integration status

This directory is a React Native New Architecture prototype, not a published app. The TypeScript spec in `specs/NativeVideoHost.ts` is the authoritative Codegen surface.

## iOS integration

1. Generate the React Native 0.87 iOS shell and add the files in `ios/NativeVideoHost` to the application target.
2. Set the bridging header to `NativeVideoHost/NativeVideoHost-Bridging-Header.h`.
3. Add `BGTaskSchedulerPermittedIdentifiers` with `com.videoagent.mobile.processing`, and register its handler during application launch. The handler must wake the JS runtime, call `DurableJobQueue.recover()`, and always call `setTaskCompleted(success:)` before expiration.
4. Add a background-processing capability only after testing the expiration path. AVAsset export is not claimed to run indefinitely in the background.
5. Run `bundle exec pod install`; React Native Codegen generates `NativeVideoHostSpec` and the Objective-C++ glue binds it to the Swift service.

The Swift implementation uses app-controlled storage for imported media. A security-scoped picker URL is only a temporary source for `copySourceAsset`; it is never written into Project identity.

## Android integration

1. Generate the React Native 0.87 Android shell and merge `android/native-host-dependencies.gradle` into `android/app/build.gradle`.
2. Add `NativeVideoHostPackage()` to the package list in `MainApplication.kt`.
3. Run `gradlew generateCodegenArtifactsFromSchema` before compilation.
4. Register `VideoAgentWorker` through WorkManager. Work is tagged with both `NativeVideoHostModule.WORK_TAG` and the job id, which is what `pendingBackground()` reads back.
5. To make the wake-up actually resume work, add a `HeadlessJsTaskService`, declare it in the manifest, and register a matching `AppRegistry.registerHeadlessTask` handler that calls `DurableJobQueue.recover()`. Until that exists, `VideoAgentWorker` only completes; recovery happens on the next foreground launch.
6. A foreground service is intentionally not enabled until a real export exceeds ordinary WorkManager constraints and the notification UX is implemented.

The picker uses `ACTION_OPEN_DOCUMENT`/SAF. `content://` is accepted only at the import boundary and copied into app-private project storage before Core sees the asset.

## Capability truth

| Operation | iOS AVFoundation | Android Media3 |
|---|---:|---:|
| trim | implemented in source | implemented in source |
| concat | implemented in source | implemented in source |
| crop/scale | export preset / aspect normalization; device verification pending | Media3 Presentation effect; device verification pending |
| preserve audio | implemented in source | implemented in source |
| speed | unsupported | unsupported |
| caption burn-in | unsupported | unsupported |
| audio ducking | unsupported | unsupported |
| overlay | unsupported | unsupported |
| background export | false | WorkManager wake-up implemented; long export verification pending |

Unsupported operations are rejected by `NativeMobileRenderer` before native execution.

## Required device smoke

Use a 1–5 minute talking-head video, complete the two-prompt flow in the milestone, then capture device model, OS, import/probe/render timings, peak memory, temporary disk usage, output size, thermal state, provider host, ContextPack byte counts, restart outcome, and exported video playback. Until that evidence exists, do not claim the milestone definition of done or production readiness.
