# Mobile Framework Evaluation

Date checked: 2026-08-24.

## Decision

Recommend **React Native New Architecture with native Swift/Kotlin media modules**, optionally using Expo development builds and selected Expo modules. Do not target Expo Go. Keep the TypeScript domain/runtime package shared with Node; implement AVFoundation, Media3, secure storage, URI import, background execution and local model bridges as typed native modules.

This choice minimizes the rewrite of the existing TypeScript Project/Workflow/Edit IR while accepting that media and sustained background work must be native. The UI calls a narrow `VideoAgentFacade`; it does not implement domain transitions.

## Comparison

| Option | Shared runtime fit | Native media/local ML | Background reality | Main cost | Verdict |
|---|---|---|---|---|---|
| React Native New Architecture | Excellent: TypeScript core remains first-class | Turbo Native Modules/Codegen support Swift, Kotlin and C++ boundaries | Requires native WorkManager/BGTask integration and durable restart logic | Native module engineering and Hermes compatibility testing | **Recommended** |
| Expo | Good when used as a React Native framework with development builds | Development builds allow arbitrary native libraries; config plugins manage native setup | Expo BackgroundTask wraps WorkManager/BGTaskScheduler but execution remains deferred/system-controlled | Expo Go cannot host custom media/ML modules; prebuild/native rebuild workflow required | Use tooling/modules, not Expo Go or a managed-only assumption |
| Capacitor | TypeScript/web reuse is high | Swift/Java plugin API exists | WebView lifecycle and binary/stream transfer are awkward for editing workloads | Large media buffers and fine-grained progress cross a web/native boundary | Not selected for a media-first runtime |
| Flutter | Domain would need a Dart rewrite or a JS engine embedding | Strong platform channels and modern FFI | Native plugins still required; isolate/channel lifecycle must be designed | Duplicates the mature TypeScript domain layer | Technically strong, strategically expensive here |
| Native Swift + Kotlin | No automatic cross-platform TypeScript runtime reuse | Best access and control | Best alignment with OS schedulers | Two app/domain implementations or embedded JS/C++ core | Reserve for native adapters, not the whole product |
| Hybrid shared C++ core + native UI | Good long-term for media/ML kernels, weak for current TS business core | Excellent | Excellent | Largest migration and binding surface | Potential V4 optimization after semantics stabilize |

## Evidence and constraints

- React Native documents typed Turbo Native Modules and Codegen for Swift/Kotlin/C++; New Architecture removes the legacy serialized bridge for supported module paths: https://reactnative.dev/docs/native-platform and https://reactnative.dev/docs/turbo-native-modules-introduction
- Expo development builds allow arbitrary native libraries/configuration; native changes require rebuilding: https://docs.expo.dev/develop/development-builds/introduction/
- Expo BackgroundTask uses WorkManager and BGTaskScheduler, is deferrable, and may resume after process/device restart; iOS scheduling is system-decided and simulator support is limited: https://docs.expo.dev/versions/latest/sdk/background-task/
- Capacitor provides a web-focused native container and Swift/Java plugin API: https://capacitorjs.com/docs
- Flutter provides platform channels/Pigeon and direct C FFI, but adopting it would move the host language away from the existing TypeScript runtime: https://docs.flutter.dev/platform-integration/platform-channels and https://docs.flutter.dev/platform-integration/bind-native-code

## Proposed app shape

```text
React Native UI
  -> VideoAgentFacade (typed commands/queries/events)
    -> shared TypeScript Mobile Host runtime
      -> Swift TurboModules: AVFoundation, Keychain, BGTaskScheduler, security-scoped import
      -> Kotlin TurboModules: Media3/MediaCodec, Keystore, WorkManager, SAF import
      -> C/C++ modules: whisper.cpp or selected local inference kernels
```

Large media never crosses the JS/native boundary as a byte array. The facade passes logical asset handles and task IDs. Native modules emit bounded progress/event records and write results into project storage atomically.

## Native proof gates before committing the UI shell

1. Import a 4K/10-minute video through Photos/SAF and persist access/copy it without loading it into JS memory.
2. Probe, trim/concat, mix/duck, caption and export with cancellation on both platforms.
3. Resume a killed render/transcription job safely, or classify it as retryable with a durable checkpoint.
4. Run quantized local ASR within memory/thermal budgets on a low/mid/high reference device set.
5. Confirm Keychain/Keystore credential deletion, backup policy and app reinstall behavior.

