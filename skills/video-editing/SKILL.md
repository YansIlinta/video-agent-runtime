---
name: video-editing
description: Operate Video Agent Runtime projects through structured MCP tools for transcript-first long-form-to-short-form editing, preview review, feedback diagnosis, narration, versioning, and approved export. Use for editing an existing runtime project; do not use for direct FFmpeg or manual project-JSON changes.
---

# Video editing runtime

Use the runtime as the project authority. Do not edit its JSON files, construct FFmpeg commands, or bypass validation.

## Start with state and evidence

1. Call `project_status`.
2. Call `system_status` before choosing a real provider path; unavailable optional alignment or TTS is not permission to pretend it ran.
3. Read the active transcript, `transcript_quality`, and timeline before proposing changes. Prefer `transcript_search`, `transcript_inspect_range`, and `timeline_inspect_range` over re-reading large artifacts.
4. Call `visual_inspect_range` only when the decision genuinely needs visual evidence. Do not inspect every frame or send the whole video to a vision model by default.
5. Surface low-confidence words, failed alignment, speaker overlap, or other transcript-quality warnings when they affect an editing decision.

## Approval-gated edit loop

For a new edit direction:

1. Understand the requested outcome and constraints.
2. Call `strategy_propose` and explain its structure, target duration, selection policy, pace, captions, and rationale.
3. Wait for explicit user approval. Then call `strategy_approve`.
4. Call `edit_plan_create`, `edit_plan_validate`, and `edit_plan_diff` in that order.
5. If validation fails, fix the structured plan; never work around it in the renderer.
6. Show the meaningful diff and apply only after it is consistent with the approved strategy.
7. Call `edit_plan_apply`, then `preview_render`.
8. Review the self-check result and ask the user to assess the preview.
9. Call `final_approve` and `export_video` only after explicit final approval.

Never treat self-evaluation as user approval.

## Feedback and replanning

- Submit the user's original words with `feedback_submit`; include category and range when known.
- For a local complaint such as “20–35 seconds is slow,” prefer the smallest plan change affecting that range. Preserve unrelated clips.
- Call `workflow_diagnose` before repeated retries.
- Use `PATCH` for a localized execution problem. Use `REPLAN` when feedback indicates the EditingStrategy is wrong.
- For `PATCH`, call `edit_patch_plan`, `edit_patch_validate`, and `edit_patch_diff`; reject out-of-scope/global mutations before `edit_patch_apply`.
- When diagnosis returns `REPLAN`, call `workflow_replan`, present the replacement strategy, and wait for a fresh approval.
- Repeated “flat,” “not interesting,” or “weak opening” feedback is evidence of a possible story-structure mismatch, not permission to randomly move cuts again.
- Explain what changed, why it changed, and which feedback caused it. Use version comparison when that is clearer.

## Transcript and speech rules

- Treat transcript words and their source timestamps as the primary semantic editing surface.
- Preserve original wording when the approved strategy requires it; never replace raw ASR evidence with cleaned display text.
- Do not re-transcribe an unchanged asset merely because the edit changed.
- TTS creates an editable narration asset and track. State the voice, provider, placement, duration fit, caption generation, and original-audio policy.
- If narration does not fit, choose among shorter wording, a modest speed adjustment, timeline extension, or a user question. Do not make speech unintelligible to force a fit.
- Never clone a detected speaker automatically. Voice cloning requires an explicit provider capability, explicit user choice, and recorded consent/usage metadata.

## Safety and scope

- Use only project-scoped MCP operations. Never request arbitrary shell, raw FFmpeg, or unrestricted path access.
- Do not persist API keys or include secrets in tool output.
- Use `version_restore`; do not delete or overwrite version history.
- When a tool fails or the host restarts, inspect `workflow_status` and resume from durable state rather than guessing what completed.
- For background work, poll `job_status`. Use `job_cancel` when the user cancels; never report cancellation until the durable job reaches `cancelled`.
- Mobile or UI clients are review consoles, not alternate project authorities.
