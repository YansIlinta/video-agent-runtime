# Mobile dependency security

This document records the current React Native dependency-audit boundary for `apps/mobile`.

## Current finding

As of 2026-08-25, `npm audit` reports seven high-severity entries in the mobile dependency closure. They are not seven independent vulnerabilities. They fan out from two `image-size` denial-of-service advisories through the React Native / Metro package graph:

```text
react-native@0.87.0
  -> @react-native/community-cli-plugin@0.87.0
      -> metro@0.87.0
          -> image-size@1.2.1
```

The direct advisories are:

- `GHSA-w3rx-r6r6-pgpr` — ICNS parsing can enter an infinite loop.
- `GHSA-5p2g-fcmc-qvqq` — JXL / HEIF parsing can enter an infinite loop.

The audit fanout currently includes `image-size`, `metro`, `metro-config`, `metro-transform-worker`, `@react-native/community-cli-plugin`, `react-native`, and `@react-native/virtualized-lists`.

## Exposure boundary

Metro is Node-side React Native bundling/tooling. The vulnerable `image-size` package is reached through Metro, not through Video Agent Runtime's native media import, ASR, Timeline, renderer, or user-video inspection paths.

This is therefore primarily a build/development availability risk: a crafted image presented to the vulnerable parser can hang the Node process. It must not be described as harmless or as a false positive. At the same time, `npm audit --omit=dev` reflects npm package dependency classification; it does not prove that the Node parser is executed inside the shipped iOS or Android application.

The project has not yet completed native iOS/Android compilation and final-binary inspection on physical devices, so no stronger binary-reachability claim is made here.

## Why React Native is not downgraded

`npm audit fix --force` currently proposes installing React Native 0.86.3. The mobile host was intentionally implemented against React Native 0.87 New Architecture contracts, so automatically downgrading the framework would be a larger compatibility change than the vulnerability itself and would invalidate existing source-level assumptions.

There is also no patched upstream `image-size` npm release for these two advisories as of the review date. A community fork is not substituted into Metro without real Metro, Codegen, iOS, and Android build evidence.

## CI policy

`npm run audit:mobile` runs `npm audit --omit=dev --json` and applies a narrow temporary exception from `apps/mobile/security-audit-allowlist.json`.

The gate fails when any of the following is true:

- a critical vulnerability is reported;
- a new high-severity advisory appears;
- a high-severity package appears outside the known Metro fanout;
- the known high findings no longer root at `image-size`;
- the temporary exception reaches its review deadline.

A clean audit also passes. The exception is therefore not a blanket `npm audit` suppression.

## Review deadline

The current exception expires on **2026-09-25**. Before extending it, re-check:

1. React Native / Metro releases for a dependency update;
2. whether `image-size` has published a patched release;
3. whether the Metro dependency can be removed or replaced upstream;
4. whether a maintained replacement can be validated with actual Metro bundling, Codegen, iOS build, Android build, and device smoke tests.

Remove the exception as soon as a verified upstream-compatible fix is available.
