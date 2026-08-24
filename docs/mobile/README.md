# Mobile host

The mobile target runs the **same** `VideoAgentCore`, Workflow, EditPlan, Timeline, Version, Job and provider contracts as the Node runtime. There is no mobile-only product model, no parallel job queue, and no application backend — the device is the whole system.

What differs is the *host*: filesystem, secure storage, HTTP, background execution, and media rendering are injected adapters. Node supplies FFmpeg and the OS filesystem; iOS supplies AVFoundation and Keychain; Android supplies Media3 and the AndroidKeyStore.

## Where to start

1. [architecture.md](architecture.md) — the audit that defined the portable boundary, and what had to move out of the Node host to get there.
2. [native-host-status.md](native-host-status.md) — **what is actually built and what is not yet proven.** Read this before trusting any capability claim.
3. [known-issues.md](known-issues.md) — open defects from source review, ranked.
4. [migration.md](migration.md) — the order to implement a new host in.

## Decision records

- [framework-evaluation.md](framework-evaluation.md) — React Native New Architecture, and what was rejected.
- [provider-auth.md](provider-auth.md) — on-device provider authentication; why direct BYOK is a constrained prototype rather than a recommended production architecture.
- [local-models.md](local-models.md) — on-device ASR/TTS candidates and the milestone ordering.

## Source layout

| Path | Contents |
| --- | --- |
| `packages/mobile/` | Portable TypeScript: adapters, project repository, provider settings, capability-gated renderer, ContextPack privacy accounting, network audit, composition root |
| `apps/mobile/specs/` | Codegen source of truth for the TurboModule surface |
| `apps/mobile/ios/` | Swift host implementation plus the Objective-C++ adapter |
| `apps/mobile/android/` | Kotlin TurboModule and Media3 renderer |
| `apps/mobile/NATIVE_INTEGRATION.md` | Steps to generate the app shells and wire the native modules in |

## Current claim boundary

Source-complete prototype. **Neither native target has been compiled or run**, on a simulator or a device. Portable contract tests pass and the Node runtime is green; that is not the same as a working app. The required real-device measurement pass is listed at the end of [native-host-status.md](native-host-status.md).
