# Security and safety

Voice references, consent evidence, derived representations and remote voice identifiers are sensitive. V2 stores them only inside the project workspace, filters provider voice IDs/provider metadata/consent evidence from normal MCP and network responses, never persists API keys or authorization headers, requires explicit enrollment confirmation, and records deletion/revocation events. Original source media is never deleted merely because a VoiceProfile is removed.

- Project IDs are validated and every resolved path must remain under `VIDEO_AGENT_WORKSPACE`.
- Imported media is copied into the project and hashed; original files are not edited.
- Subprocesses use executable-plus-argument arrays with timeouts and captured diagnostics. MCP exposes domain operations, not a shell or arbitrary FFmpeg arguments.
- Every plan is schema-validated and semantically checked for negative time, invalid ranges, missing assets, source overflow, and clip overlap before mutation.
- Writes are atomic with backup recovery; applied changes create immutable versions and a structured diff.
- Strategy approval is required before planning. Final approval of the active version is required before export.
- API keys belong in process environment variables. They are not accepted by tools or persisted in project files.
- Voice cloning is not implemented. Voice profiles carry provider/model/license metadata; adding cloning later must require explicit consent and provenance.
- Optional Python speech environments should be isolated and model licenses reviewed before redistribution.
- Provider and executable selection is centralized in the configuration layer; credentials are read separately from environment-only secret configuration.
- FFmpeg renders to a unique temporary output, probes it, then atomically finalizes. Cancellation terminates the child and removes temporary media and captions.
- Startup recovery sweeps only explicit project temp/render suffixes. Source assets are excluded from cleanup.
- Quotas cover input size/duration, preview range, project disk, retained previews, global/type-specific worker concurrency and retry attempts.

This is a local execution engine, not a hardened multi-tenant service. A network deployment still needs authentication, authorization, quotas, malware scanning, isolated workers, encrypted storage, and audit retention policy.
