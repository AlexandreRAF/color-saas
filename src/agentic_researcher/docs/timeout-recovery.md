# Timeout recovery and bounded model work

## Evidence and scope

Changed only `backend_serper_qwen_efficient`. The preceding Corolla run took
67.3 seconds, returned the required Branco Lunar/089 and a separate 070 candidate,
but left 24 omission checks unfinished. It made 71 model attempts, including
nine timeouts, and used 17 Serper credits. The reported $0.066844 excluded those
nine attempts' missing usage and was not a complete cost estimate.

Saved requests show why measuring only review input was insufficient:

| Timed-out request | Full input transport characters | Output allowance | Combined sizing weight |
| --- | ---: | ---: | ---: |
| Review batch 2 | 68,926 | 4,064 tokens | 85,182 |
| Omission audit 4 | 59,327 | 1,144 tokens | 63,903 |
| Final verification V13 | 19,204 | 2,000 tokens | 27,204 |

These are conservative character-based sizing weights, not actual token counts.
Qwen's wire format repeats the structured schema; both copies are counted.
The first two requests now exceed their respective pre-send batch limits.

## Changes

1. `request_envelope.js` constructs the same payload used for sizing and sending.
   Reviews share exact passages, pages and catalog rows. Batch limits count the
   complete provider payload plus four characters per allowed output token.
   Page transport and verification use the same sizing function. Splitting
   preserves source IDs, catalog identity boundaries and every owned passage.
   Single indivisible candidates retain their full evidence.

2. `model_stream.js` consumes Chat Completions and Responses SSE. Only nonempty,
   non-whitespace output-text deltas reset the idle timer. Comments, role-only
   events, heartbeats and reasoning events do not count. First-content allowance
   is 4–6 seconds by input size; idle allowance is 2.5 seconds. Qwen absolute
   limits are 6–12 seconds (8–12 for reviews); GPT limits are at most 12 seconds.
   Caller and explicit routing limits still cap attempts. Completed structured
   output remains mandatory. Streaming adapters follow the documented
   [Responses events](https://developers.openai.com/api/docs/guides/streaming-responses)
   and [OpenRouter streaming format](https://openrouter.ai/docs/api_reference/streaming).

3. Review, page and verification transports split a timed-out batch once before
   continuing after the failed route. Complete top-level decisions must pass
   their own schemas and existing evidence validators before reuse. Missing or
   invalid children go into smaller groups; no successful sibling is regenerated.
   Split children retain the normal remaining fallback order, shared scheduler
   and budget. Failed halves preserve other halves' decisions and honest coverage
   counts. Omission audits require complete per-group output because an unfinished
   empty reconsideration list cannot establish that every candidate was checked.

4. The existing scheduler now limits all model pools together to 16 active calls,
   reserving four slots for completion work. Normal extraction/catalog/review
   calls cannot consume that headroom. Repairs and split recovery have completion
   priority. Qwen's default pool ceiling is 12. Network pools remain independent.
   The same rule runs in the Unix coordinator when configured, so it is shared
   by all connected processes. No additional candidate-admission queue was added.

5. The $0.06 soft AI target protects 10% specifically for the omission audit,
   alongside 35% review, 6% matching, 6% completion repair and up to 20% final
   verification allowances. These protect unspent funds; they are not separate
   spending authorizations. An audit releases its unused allowance when settled.
   Every sent model attempt publishes usage once, including unknown usage on
   timeouts or failed streams. Unknown charges retain conservative admission
   reservations. Public estimates become null when incomplete, with
   `missingUsageCalls`, `costComplete` and `knownCostUsd` making the distinction
   explicit. Known cost survives a failed call in the same model/stage.

## Validation and limits

**446 offline tests passed**, with no failures, skips or cancellations (56.2 s).
[Full regression log](../../tmp/efficient-five-final-offline.log).

The offline suite covers progress/idle/absolute timeouts, heartbeat-only streams,
SSE chunk boundaries, caller cancellation, fallback ordering, missing usage,
partial decision recovery, one-wave splitting, exact source preservation,
shared completion headroom and protected audit funds. It also retains the
existing catalog, finish, hue, name, matching and vehicle-runner regressions.

No paid model or search calls were made for this implementation. The original
backend's 114 snapshotted files remain unchanged. Live palette accuracy, costs
and the 50-second soft target have not been remeasured. These changes bound and
reduce avoidable work; they do not create provider capacity or guarantee latency.
