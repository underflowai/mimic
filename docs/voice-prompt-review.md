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

## Follow-up changes

A second pass kept most of the above and reversed or adjusted the following. Where this section disagrees with the text above, this section describes the shipped behavior.

- **Unclassified tools default to `read`, not `write`.** Tools that predate `kind` are lookups in practice; forcing them through the authorization gate stalled reads. Declare `kind: 'write'` for anything that acts.
- **Recipient details are out of the compiler input and the cache key.** The compiled prompt refers to `callerFirstName` / `callerLastName` / `callerEmail`, which the runtime injects per call, so one goal compiles once however many people are called.
- **Data values are out of the compiler input and the cache key too** (`voice-prompts-v5`). The compiler sees the shape of `data` — field names, which fields are supplied, valid options and metadata — and writes a prompt that refers to fields by name; the values are stored on the call (`api_calls.call_data`) and appended to that call's system prompt in a `<data>` block. Fifty calls with the same fields and different values compile once instead of fifty times at ~30s each. A field flipping between supplied and missing still recompiles, since that changes what the agent has to collect.
- **The goal compiler is compact and principle-based.** Universal situational behavior stays in runtime control blocks instead of being compiled into every agent. In representative calls, compiled system prompts fell from 1,595–2,043 words to 551–587 while retaining identity, privacy, tool-result, and completion boundaries. `compilerRevision` is `voice-prompts-v4`.
- **Spoken cadence keeps the one-in-three filler line and now reaches compiled agents.** Removing it flattened the voice; the SSML `<break>` markup is what the TTS layer expects.
- **The OpenAI voice director is `chat-latest`.** On the compact-prompt eval, Sol low scored 9.31/10 versus Chat's 8.78 but added about 646 ms to median TTFT. Production returned to Chat to prioritize live-call latency; Sol remains the measured quality option.
- **Eager promotion prompt restored.** The original wording and labeled input format were validated on a 42×6×3×3 eval (97.6%, no false positives); the rewrite was not. The fast path now also accepts finals that differ from the spec only by hesitation tokens (`um`, `uh`, …), which the classifier handled identically.
- **Web search enrichment over 150 words is truncated at a sentence boundary** rather than discarded, so a long result still yields a handoff.
- **Tool watcher.** `writeAuthorizationQuote` is checked with normalized substring containment against caller turns (punctuation, case, and curly quotes no longer cause false rejections); the quote must still be the caller's words. One tool with an unusable schema no longer disables the others. The watcher sees the last 20 turns rather than the full call.
- **Backchannel classifier** picks from a named neutral subset exported from `tokens.ts` and runs at temperature 1 again.
- **Caller timezone is guessed from the area code when not supplied.** The server infers an IANA zone from the dialed number (one guess when the area code maps to one or two zones; none for toll-free or country-wide prefixes). The date line is labeled as an unconfirmed guess, the director is told to confirm it in passing the first time a specific time matters and to make light of it if wrong, and the tool watcher does not schedule against the guessed zone until the caller confirms or names one.
- **SDK 0.3.0.** Tool parameters serialize through `zod-to-json-schema` (Zod 3) or `zod/v4/core` (Zod 4); the MCP SDK is loaded only when `mcp()` is used. See `packages/sdk/CHANGELOG.md`.

## Turn-taking pass

A third pass worked from two production calls pulled from the worker logs rather than from prompts. Recommendation 1 above (a hold state) is now implemented; the rest of this section lists what the logs showed and what changed.

- **Promoted turns lost their handle.** When a final transcript arrived while an eager draft was still generating, the turn ran as a fresh generation, then restarted under the same `turnId` with the presynthesized draft. The superseded pipeline's async teardown cleared the turn's `ActiveTurnHandle` by id, which wiped the replacement: barge-ins could not stop the audio, the heard portion was lost, and the commit waited out the 5s playback timeout. In one call the agent spoke an unstoppable 27-word reply and the caller answered a question the agent had "lost". Handles are now cleared by identity, and the superseded LLM stream is aborted.
- **Dead air before the first word.** Median time to first token was 1.4s at night and 5.1s in the morning call; the caller said "Hello?" into the gap. Fresh turns that answer a caller now speak a short neutral filler ("Hmm.", "Let me see.", "Mm-hmm.") if the first token is later than `MIMIC_LATENCY_FILLER_MS` (1s). TTFT still measures the model. Token-usage logging, broken because the usage chunk has no `choices`, is fixed, so prompt-cache hit rates are visible again.
- **End-of-turn confidence was ignored.** A timeout-forced final at 0.22 confidence ("my email is john dot") was answered as if complete. Finals under `MIMIC_LOW_CONFIDENCE_EOT` (0.35) now carry `control-block/trailing-off.md` and bypass eager reuse; eager boundaries under the same floor are not speculated on. After the agent asks for an email, phone number, spelling, or similar, Flux runs with stricter thresholds for one caller turn. `transcriber.configure` merges options so keyterm updates and threshold changes no longer overwrite each other on reconnect.
- **Barge-in was VAD-only.** Three of four soft pauses in the logs were hiccups, and the agent interrupted itself on them. The soft pause now waits for the transcriber: listening noises resume (and their later end-of-turn is dropped), a short "yeah" after a question the agent just asked resumes without being dropped, real words interrupt, and VAD with no words after a grace window is treated as noise. Interim transcripts are forwarded to the turn actor for this.
- **Hold requests.** "Hang on, let me grab my calendar" or a silence follow-up the director answers with nothing switches the watchdog to `MIMIC_HOLD_IDLE_MS` (45s) until the caller's next real turn.

Not changed: the dental opening still names the reason for the call before confirming who answered (a privacy call for the prompt author), and the backchannel engine remains unwired in the server.

## Verified actions

Recommendation 3 above concerned argument invalidation; the shipped change is narrower and deterministic. `write-gate.ts` checks each write-tool argument against the caller's words, prior read results, and the integrator's per-call data and context. A phone number, email, or code that appears in none of them holds the write with a `verify:<arg>` blocker and a readback note for the director; the authorizing-quote check still applies. Everything else (dates, names, free text) is recorded as an evidence span or an unverified argument in the watcher log, not blocked — their formats vary too much to block on without a corpus showing it is safe.
