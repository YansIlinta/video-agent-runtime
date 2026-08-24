# Security Policy

Video Agent Runtime handles local media, provider credentials, generated speech, and optional voice-reference material. Security-sensitive changes should preserve the boundaries documented in [`docs/security.md`](docs/security.md).

## Reporting a vulnerability

Please do not include live API keys, private media, voice-reference files, authorization evidence, access tokens, or other secrets in a public issue or pull request.

If the issue can be demonstrated without sensitive material, open a GitHub issue with:

- the affected version / commit,
- the affected surface (`CLI`, project MCP, speech MCP, Control API, mobile host, provider adapter, renderer, persistence),
- reproduction steps using synthetic or non-sensitive fixtures,
- impact,
- whether the issue crosses a trust boundary (filesystem, network, credentials, voice identity, process execution).

For vulnerabilities that cannot be safely described publicly, use GitHub's private vulnerability reporting / security advisory flow when it is available for this repository rather than posting the exploit details publicly.

## Security boundaries

The project is designed around these rules:

- agents do not receive arbitrary shell execution through the editing API,
- raw FFmpeg strings are not authoritative project state,
- project/workspace paths are constrained,
- API keys are not persisted in project JSON, ProviderCall records, benchmark reports, or MCP output,
- mobile credentials are referenced through secure host storage,
- source media remains local unless a workflow explicitly sends approved evidence to a provider,
- large local files are not intentionally exposed through a generic arbitrary-upload native bridge,
- provider responses are normalized and schema-validated before mutating project state,
- voice cloning requires explicit authorization and provenance,
- detected speakers are not automatically enrolled as cloned voices.

## Voice identity

Voice reference material is sensitive project data.

Security reports involving voice identity should distinguish:

- reference media leakage,
- authorization/provenance bypass,
- unintended speaker selection,
- silent embedding-only fallback,
- remote-provider retention/deletion behavior,
- generated-audio provenance loss.

Do not attach a real person's voice sample to a public security report unless you have permission to publish it.

## Provider credentials

A credential appearing in any of these locations should be treated as a defect:

- project JSON,
- Transcript / Timeline / Version persistence,
- JobEvent,
- ProviderCall durable metadata,
- NetworkAudit content fields,
- ContextPack reports,
- real-provider benchmark JSON/Markdown,
- normal logs,
- MCP responses.

Rotate any credential that was accidentally committed or disclosed; deleting it from Git history is not sufficient to make it safe again.

## Supported security scope

The Node runtime is the primary verified runtime path.

The mobile host is still subject to its documented native-build/device-validation boundary. A source-level Swift/Kotlin implementation or TypeScript contract should not be interpreted as proof of native platform security behavior until it has been compiled and tested on the relevant platform.

See also:

- [`docs/security.md`](docs/security.md)
- [`docs/mobile/provider-auth.md`](docs/mobile/provider-auth.md)
- [`docs/voice-identity.md`](docs/voice-identity.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
