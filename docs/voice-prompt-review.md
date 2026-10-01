# Voice prompt review

Reviewed against main commit `633d076` and checked against the subsequent `a42a3fc` checkout (only the dependency lockfile changed between them). Coverage includes all 19 existing production prompt files, their runtime inputs and output schemas, inline example prompts, the public SDK, and prompt caching. The current goal-compiler rewrite on main was retained; the other layers were brought into agreement with it.

## Prompt-by-prompt findings and changes

Paths below are relative to `packages/engine/src/prompts/`.

| Prompt                                        | Finding and improvement                                                                                                                                                                                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions/goal-compiler.md`               | Retained the recent task-specific rewrite. Fixed its code inputs to include actual runtime tools, supported speech markup, and full supplied field metadata. Preserved configured agent names.                                                                       |
| `instructions/web-searcher.md`                | Removed company profiling. Required focused research for each assignment, explicit time windows, relevant sources, and uncertainty. Corrected `provide_enrichment`: it is the structured output format, not a callable tool. Aligned the handoff limit at 150 words. |
| `instructions/tool-watcher.md`                | Separated relevant reads from authorized writes. Removed implicit confirmation from silence, guessed dates, and automatically ready classifications. Preserved typed arguments and earlier caller information. Added explicit withdrawal handling.                   |
| `instructions/tool-result-nudge.md`           | Stopped claiming a result has just arrived merely because historical tool messages exist. Removed the forced closing response.                                                                                                                                       |
| `instructions/backchannel-classifier.md`      | Avoided tokens that imply agreement or permission. Requests, corrections, refusals, and serious disclosures should not trigger an affirming interruption.                                                                                                            |
| `instructions/eager-promotion-classifier.md`  | A continuation on the same topic can still invalidate a prepared response. Added conservative handling of new constraints, answered questions, corrections, and changed commitments.                                                                                 |
| `instructions/conversation-summary.md`        | Preserve corrected details, refusals, unresolved requests, and actual versus claimed outcomes. Do not convert politeness into agreement or sales interest.                                                                                                           |
| `instructions/entity-extraction.md`           | Extract observed relevant names and spelling corrections, without fabricating identities or treating identifiers as proper names.                                                                                                                                    |
| `instructions/result-extractor.md`            | Separate unknown from false, a request from completion, and agent claims from tool evidence. Every requested field remains represented.                                                                                                                              |
| `control-block/spoken-cadence.md`             | Removed forced filler frequency and stretched spellings. Reinforced short, direct spoken responses without compulsory questions or offers.                                                                                                                           |
| `control-block/transcript-quality.md`         | Context can resolve harmless recognition errors; consequential identifiers, dates, amounts, negation, and consent need focused clarification when unclear.                                                                                                           |
| `control-block/tools-available.md`            | Availability of a tool no longer implies it has started. Removed unconditional stall lines and promised imminent results.                                                                                                                                            |
| `control-block/tool-running.md`               | Brief progress language only for actual execution. No claimed outcome before a result.                                                                                                                                                                               |
| `control-block/tool-classification-failed.md` | A classification failure establishes neither execution nor success. Avoid repeating the request unnecessarily.                                                                                                                                                       |
| `control-block/interrupt.md`                  | Follow the latest caller input; do not finish an obsolete question or pitch. Mark heard and unheard excerpts as contextual data.                                                                                                                                     |
| `control-block/end-call.md`                   | Allow a clear caller-requested exit even when fields or tasks remain incomplete. Distinguish a pause from goodbye.                                                                                                                                                   |
| `control-block/silence-follow-up.md`          | Avoid repeated acknowledgments, pitches, and tool stalls during silence. Account for a prior request to wait.                                                                                                                                                        |
| `control-block/silence-closing.md`            | Keep timeout closing brief and accurate; do not imply unresolved work succeeded.                                                                                                                                                                                     |
| `voice-api-template.md`                       | Preserved the compiled-prompt and speech-tag contract; removed the document-style Markdown heading.                                                                                                                                                                  |

Added `control-block/turn-priorities.md` so compiled and caller-authored persona agents share the same rules for pauses, corrections, refusals, tool evidence, and task scope.

## Code changes that make the prompts effective

- Research now requires a completed web-search response before enrichment is accepted. Incomplete, search-free, or oversized output is rejected.
- Tool schemas retain booleans, numbers, enums, arrays, objects, and required/optional distinctions from SDK or MCP input through classification. The API no longer overwrites every tool kind with `read`.
- Write decisions require an exact authorizing caller utterance in the provided history. Semantic relevance and confirmation are still assessed by the model; a quote match alone is not a proof of intent.
- Missing arguments and `not_ready` decisions block execution. An explicit withdrawal cancels an awaiting action without cancelling unrelated running tools.
- Supervisor state now distinguishes tools awaiting information from tools actually executing, including concurrent invocations.
- Caller timezone reaches the opening, later turns, watcher, and researcher. Missing or invalid runtime zones use a labeled UTC reference rather than an assumed Los Angeles timezone.
- Custom agent identity survives compilation and runtime assembly. Global name replacement no longer corrupts unrelated names, addresses, or contact details.
- API calls enable the existing end-call protocol so a spoken goodbye can actually end a call.
- Eager drafts no longer bypass semantic validation merely because the final transcript adds only one or two words.
- Summaries refresh as calls grow. Unsummarized turns remain available while a new summary is pending, preventing older caller details from disappearing.
- Post-call extraction uses `null` for unestablished facts, checks output types, and requires explicit tool-success evidence for tool-based success conditions. SDK result types reflect nullable values.
- Compiled-agent cache keys include a compiler revision and recipient details. New goal-based requests receive the updated compiler; explicit agent IDs still intentionally select stored agents.

## Examples and compatibility

The Aurora scripts were reviewed as deliberate product demonstrations. Their goals now follow caller questions without assuming a call-volume problem, prior website submission, or desire for a founder meeting. Removed stale company metrics and blanket claims from the sample context. The SDK calendar example clearly labels simulated results. Calendar-free documentation examples collect a preference rather than promise availability.

Declare `kind: 'read'` for lookup-only tools and `kind: 'write'` for actions. Unclassified tools now default to write instead of bypassing action checks. MCP tools use read mode only with an explicit `readOnlyHint: true`. Existing stored agent IDs retain their saved tool definitions and prompts; create a new configuration to adopt updated definitions.

Each extracted field can be `null` when the call did not establish it, including boolean fields. Consumers should distinguish `false` from `null`. This is reflected in the exported SDK result type.

## Remaining recommendations

1. Add an explicit caller-requested hold state to the call machine. Prompt wording now respects pauses, but the existing bounded silence watchdog still cannot distinguish every requested hold from an abandoned call.
2. Track tool-result delivery by generation and playback. Historical tool presence alone cannot prove which result the caller heard, especially after interruption or speculative generation.
3. Make pending-argument invalidation explicit. Current readiness blockers stop incomplete writes, but the invocation argument merge does not represent every correction-to-unknown or deliberate null update cleanly.
4. Evaluate these prompts on recorded or synthetic multi-turn conversations with the configured voice and models. Check interruptions, short corrections, refusals, readbacks, tool failures, and speech latency. More conservative eager reuse trades some speed for a lower risk of speaking an obsolete answer.

## Validation

- Engine: 455 passed, 18 skipped, 0 failed.
- SDK: 35 passed, 0 failed.
- Server: 25 passed, 0 failed.
- All four package builds and TypeScript checks passed.
- Changed-file formatting and `git diff --check` passed.

No live phone calls or paid model evaluations were performed as part of this review. Validation uses mocked model/tool responses, state-machine tests, SDK serialization tests, TypeScript checks, and workspace builds.
