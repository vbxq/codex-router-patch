# v2 agent application: `openrouter/muse-spark-1.3-contributor`

## Route

- Routed slug: `openrouter/muse-spark-1.3-contributor`
- Upstream model ID: `meta/muse-spark-1.3-contributor`
- Provider endpoint: OpenRouter Responses gateway
- Router version and test date: `0.5.1`, 2026-09-08

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Official model identity | pass | OpenRouter’s model page identifies the exact Muse Spark 1.3 Contributor route; the API reference documents the Responses endpoint. |
| Streaming Responses | pass | A live routed Responses request returned HTTP 200, streamed output, and completed normally. |
| Forced function call | pass | A live request returned HTTP 200 with a valid function-call envelope and JSON arguments. |
| Encrypted relay | pass | A native Muse parent delegated a named child through the router’s encrypted handoff path; the child turn completed on the routed model. |
| Marker-return spawn | pass | The child returned the exact first marker `MUSE_FOLLOWUP_TASK_1_DONE` and the parent observed it after `wait_agent`. |
| Same-thread follow-up | pass | `followup_task` resumed the same idle child; a second routed turn returned `MUSE_FOLLOWUP_TASK_2_DONE`, observed by the parent after a second `wait_agent`. |
| Native Codex app tool | pass | The same live parent called `mcp__codex_app__list_threads` with `{"limit":1}` and received the normal thread-list response. |

## Limits and reviewer reproduction

Reproduction requires an active OpenRouter route and a Codex client with native
multi-agent v2 enabled. Spawn a named child, wait for the first exact marker,
use `followup_task` on that same child, wait for the second marker, and call a
Codex app tool. The router must remain running throughout; no credentials,
encrypted payloads, raw prompts, or provider response bodies are stored here.
