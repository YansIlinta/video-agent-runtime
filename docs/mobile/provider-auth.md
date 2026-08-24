# Provider Mobile Authentication

Date checked: 2026-08-24. This is a product/security decision record, not a claim that every provider permits every client environment. Provider terms and CORS/network behavior must be rechecked before release.

## Modes

- `DIRECT_BYOK`: the user supplies their own provider credential. It is stored only through `SecureStorageAdapter`; project/config JSON contains a `credentialRef`. The phone calls the provider directly. This meets the zero app-owned-server requirement but cannot protect a long-lived key from a compromised user device.
- `PROVIDER_NATIVE_AUTH`: provider-supported OAuth/PKCE, attested mobile SDK, or short-lived client token. Prefer this when it exists for the required API.
- `CUSTOM_RELAY`: an optional deployment owned by the app operator or enterprise. It may enforce policy, mint short-lived tokens, or conceal an operator-funded key. It is never required for a user's own BYOK project.

## Provider matrix

| Provider | Direct BYOK | Recommended production auth | Model discovery | Mobile security position |
|---|---|---|---|---|
| OpenAI | Technically possible through portable HTTPS, but not recommended for an operator-owned long-lived key | BYOK in OS secure storage for advanced/local-first users; optional relay for operator-funded Responses calls; Realtime may use short-lived client secrets minted by a trusted service | `GET /v1/models` | Official Realtime client secrets are explicitly intended for web/mobile clients and avoid exposing the main key, but creating them is itself a trusted-service operation. They do not generalize to every Responses/audio endpoint. |
| Anthropic | API supports `x-api-key`; treat direct mobile storage as advanced BYOK only | User BYOK or optional relay/workload-identity service | `GET /v1/models` | Official API auth is API key or short-lived workload-identity bearer token. No consumer mobile PKCE flow was established by the reviewed API docs. Do not market direct key storage as provider-native mobile auth. |
| Gemini | Raw Developer API key direct from app is not the recommended production route | Firebase AI Logic client SDK + App Check for supported calls; Google OAuth where appropriate; Live API ephemeral tokens still require a backend issuer | Provider model listing API / SDK | Firebase AI Logic is specifically designed for direct mobile/web calls and keeps the Gemini Developer API credential out of app code. Live ephemeral tokens currently apply only to Live API and are provisioned by a backend. |
| DeepSeek | API-key Bearer auth; advanced BYOK only | BYOK secure storage or optional relay | Static fallback; probe compatible model endpoint when available | Reviewed official quickstart documents OpenAI/Anthropic-compatible API-key access, not provider-native mobile OAuth. |
| OpenRouter | Yes | OAuth PKCE to obtain a user-controlled key, then OS secure storage; manual BYOK remains available | `GET /api/v1/models` | OpenRouter documents PKCE and exchanging the code for a user-controlled API key, making it the clearest provider-native connection flow in this set. |
| OpenAI-compatible/custom | Depends on endpoint | Local-network endpoint with no secret, user credential in secure storage, mTLS/native auth, or optional relay | Try `/models`, then static/manual entry | Never assume TLS quality, CORS, schema parity, streaming, or reasoning parameter compatibility. Run capability probes. |

## Required implementation behavior

1. Provider configs are safe to serialize and export; credentials are not.
2. `SecureStorageAdapter.delete()` is called when a provider connection is removed if the user requests credential removal.
3. Logs and `ProviderCall` contain provider/model/request ID/usage/latency/validation, never Authorization headers or context text.
4. Direct connections display destination host and the exact `ContextPack` fields before first approval.
5. The default remote policy is text-only: no raw audio/video, file paths, logical URIs, or unapproved OCR.
6. Custom endpoints require HTTPS by default. Plain HTTP is restricted to explicit local-network profiles and must show an interceptable-traffic warning.
7. OAuth tokens, ephemeral tokens and ordinary API keys are all credential values behind references; their refresh/expiry metadata is non-secret configuration.

## Provider-specific cautions

### OpenAI

OpenAI's model list endpoint supports runtime discovery. The official Realtime client-secret API says the returned short-lived value can be passed to a web or mobile app without leaking the main API key. Therefore:

- `DIRECT_BYOK` is supported for a user's own key, with a prominent risk warning.
- `PROVIDER_NATIVE_AUTH` is marked “endpoint-limited”: Realtime client secrets only where documented.
- Operator-funded general LLM usage requires `CUSTOM_RELAY` or a future official client credential flow; embedding an operator key is prohibited.

Sources: https://developers.openai.com/api/reference/resources/models, https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create

### Anthropic

The official API overview documents `x-api-key` or a short-lived bearer token obtained through Workload Identity Federation, plus `GET /v1/models`. Workload identity is service/workload auth rather than an end-user mobile login in the reviewed documentation.

Source: https://platform.claude.com/docs/en/api/overview

### Gemini

Firebase AI Logic officially targets direct mobile/web access and integrates App Check; its proxy keeps the Gemini Developer API key on managed infrastructure. Gemini Live ephemeral tokens reduce exposure but currently require backend provisioning and are Live-only.

Sources: https://firebase.google.com/docs/ai-logic, https://firebase.google.com/docs/ai-logic/faq-and-troubleshooting, https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens

### DeepSeek

DeepSeek's official quickstart documents Bearer API-key auth and OpenAI/Anthropic-compatible base URLs. The runtime therefore uses OpenAI-compatible request mapping with provider-specific thinking fields and a static model fallback.

Source: https://api-docs.deepseek.com/

### OpenRouter

OpenRouter officially documents S256 PKCE and code exchange for a user-controlled key, plus its model API. The app should use a universal/deep-link callback on device and bind the verifier to a single connection attempt.

Sources: https://openrouter.ai/docs/guides/overview/auth/oauth, https://openrouter.ai/docs/guides/overview/models

## Threat model

Protected: accidental project export, ordinary filesystem inspection, logs, backups where OS secure storage exclusions apply, and cross-provider credential confusion. Not protected: rooted/jailbroken devices, runtime instrumentation, malicious accessibility/keyboard software, screenshots of a user-entered key, or a provider receiving approved context. Users can revoke keys at the provider and delete local references.

