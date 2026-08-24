# Narrow mobile/control API

Run `VIDEO_AGENT_API_TOKEN=<random secret> npm run cli -- api`. The server binds to `127.0.0.1:8787` by default and requires `Authorization: Bearer <token>` on every request. It is a thin wrapper over the same `VideoAgentCore`; it owns no editing logic.

Initial endpoints:

- `GET /v1/projects`
- `GET /v1/projects/:id`
- `POST /v1/projects/:id/upload` (`sourcePath`, or `filename` + `fileBase64`)
- `POST /v1/projects/:id/proposal`
- `POST /v1/projects/:id/approval`
- `POST /v1/projects/:id/preview`
- `POST /v1/projects/:id/feedback`
- `GET /v1/projects/:id/versions/compare?from=1&to=2`
- `GET /v1/projects/:id/voices`
- `POST /v1/projects/:id/voices/design`
- `POST /v1/projects/:id/voices/enroll`
- `POST /v1/projects/:id/export`
- `GET /v1/projects/:id/jobs` and `GET /v1/projects/:id/jobs/:jobId`

Expensive operations return durable jobs and clients poll the shared job endpoint. Responses omit provider voice IDs, provider metadata, consent evidence, embeddings and raw reference media. TLS termination, user accounts, resumable multipart uploads and push notifications belong to the next mobile deployment milestone.
