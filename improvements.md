# Mimic — Improvement Roadmap

Synthesis of a full architecture review (engine, server, SDK, transport), competitive calibration
(Bland / Retell / Vapi / GPT-Live-style full-duplex), and design discussion. Two standing
constraints apply to everything below:

- **No custom model training.** Everything here is prompts, heuristics, DSP, provider features, or
  plain engineering.
- **No new pre-canned audio clips.** Prefer audio generated per-call through the live TTS pipeline.

Where you already stand: the engine is the differentiated asset — eager speculation with racing
promotion and mid-turn swap, the soft-pause ladder, heard-portion interrupt commits, background
tool supervision, and the goal compiler. The platform around it (server, lifecycle, evals,
telephony robustness) is where most of the gaps are.

---

## 0. Urgent — do these first (P0)

- [x] **Rotate the leaked API key.** `examples/aurora-call.ts:4` has a live `mk_live_…` key,
      the production Railway URL, and a real phone number committed to git history. Rotate the key,
      scrub the file, and consider history rewrite if the repo will ever be shared.
      *(Done: revoked in prod DB, new key minted into gitignored `.env`, example reads env vars.)*
- [x] **Fix the split-worker topology.** Event streaming and tool bridging live in in-process Maps
      (`activeCallSubscribers`, `activeToolHandlers` in `packages/server/src/call-runner.ts`). In the
      documented API + dedicated-worker deployment, the SDK's WebSocket lands on the API process
      while calls run in the worker — live events never arrive and local tools always fail. Needs
      Redis pub/sub (or move the WS to the worker). The README advertises this topology today.
      *(Done: `packages/server/src/call-bus.ts` — Redis pub/sub for events, tool request/response
      bridge with cross-process single-owner lock.)*
- [x] **Make cancel actually hang up.** `DELETE /calls/:id` on an in-progress call only flips the DB
      flag; nothing deletes the LiveKit room or ends the SIP call. The phone keeps ringing/talking
      until the callee hangs up or the 1-hour session timeout.
      *(Done: cancel now deletes the LiveKit room, which ends the SIP leg and agent session.)*
- [x] **Persist `tool_calls`.** The `api_calls.tool_calls` column is never written, which also makes
      the `tool_called` success condition unreachable (`call-runner.ts` never passes tool calls into
      extraction). Prerequisite for verified actions, the audit trail, and the eval loop.
      *(Done: recorded per call in `call-runner.ts`, written to the DB, passed into extraction.)*

---

## 1. Latency & responsiveness (engine)

The structural insight: today Flux `EndOfTurn` is a hard gate, speculation is a single
event-triggered draft, and the first *sentence* is the TTS unit. All three can be relaxed.

### 1.1 Stop waiting for Flux to declare end-of-turn

- [x] **Early commit on converging evidence.** When local VAD reports silence, the partial
      transcript is syntactically complete, and a validated eager draft is ready — commit the turn
      ~200–250ms after VAD end instead of waiting for the `eot_threshold=0.5` crossing. Flux EOT
      becomes confirmation, not gate. A wrong early commit is exactly the failure the soft-pause /
      `TurnResumed` / heard-portion machinery already recovers from; we can afford a small
      false-commit rate for a large latency win. Tune the guard interval from the replay corpus
      (§6.1), not by feel. Watch `vad_end_to_turn_complete` — that whole window is the prize.
      *(Done: `turn/early-commit.ts` controller wired into the runtime — fires a synthetic
      `caller_turn_complete` when VAD silence + ready eager draft + unchanged partial converge;
      guard 180ms after closed questions / 240ms neutral, disabled after open questions and for
      slow callers; `mimic.early_commit.{fired,confirmed,superseded,saved_ms}` telemetry.)*
- [x] **Question-aware turn boundaries.** After the agent asks a closed question ("Does 2pm work?"),
      expected replies are 1–5 words — commit aggressively, even on eager alone. After open prompts,
      stretch patience and treat mid-utterance silence as thinking. Detection: regex on the agent's
      final sentence or one extra streamed field from the director. All the knobs
      (`substantiveSpeechMs`, watchdog delay, early-commit eligibility) are already runtime values.
      *(Done: `turn/expected-reply.ts` classifies the agent's final question (short/long/neutral);
      drives the silence-watchdog delay (5s/6s/9s) and the early-commit guard.)*
- [ ] **Prosodic silence classification (DSP, not ML).** Falling pitch + trailing energy decay into
      silence is a strong completion cue; flat/held pitch suggests continuation. Compute from the
      PCM already flowing through the VAD path; use as one input to the early-commit rule.

### 1.2 First audio = first clause, not first sentence

- [x] **Generated filler-first openings.** Constrain the director (via `turnControlBlock`) to open
      every turn with a ≤4-word reactive clause ("Yeah, so—" / "Okay—") before the substance.
      Contextual, in-voice, prosodically continuous — the no-clips version of instant onset.
      *(Done: goal compiler requires it in every `turnControlBlock`; fallback line added for
      uncompiled prompts in `turn-control-block-builder.ts`.)*
- [x] **Clause-level flush for the first chunk only.** The sentence chunker
      (`audio/streams/sentence-chunker.ts`) holds until a sentence boundary. For the first emission
      of a turn, flush at clause boundaries (comma, "so", "and", dash); revert to sentence-sized
      chunks once audio has started. Cartesia continuations carry prosody across increments on one
      context; `max_buffer_delay_ms: 0` already means it speaks what we send. Combined with
      filler-first: first audio ≈ TTS latency on ~3 words (~150–250ms).
      *(Done: `firstClauseFlush` option on the chunker — first boundary at comma/semicolon/colon/
      dash, 48-char scan cap, number-comma safe; enabled for all token pipelines.)*
- [x] **Predicted outputs on the racing-fresh path.** When promotion races fresh generation, pass
      the eager draft as an OpenAI predicted-output. Fresh regeneration gets dramatically faster
      exactly when it agrees with the draft (the common case), converging the worst path toward the
      best path. One parameter.
      *(Done: eager draft threads through `selectStrategy` → run-turn-actor → director as the
      `prediction` param when the provider is OpenAI; falls back to a plain request if the
      prediction is rejected.)*
- [x] **Pre-synthesize the greeting.** The opening line is fully known before dialing, but
      `first_turn` generates fresh — the callee's "Hello?" is followed by the longest silence of the
      call, exactly when humans respond fastest. Synthesize during SIP setup (per-call, through the
      normal pipeline) and flush on pickup; the presynthesized-audio path already exists.
      *(Done: `prepareGreeting` runs LLM + spec-TTS into a capture sink during `connectServices`
      (phone still ringing); `start_first_turn` carries the prepared audio and the first turn
      flushes it through the presynth path, falling back to fresh generation on any failure.)*

### 1.3 Audit the fixed costs

- [ ] Caller audio is coalesced to **80ms chunks** before Flux (`audioChunkTargetMs`) — evaluate
      40ms (up to 40ms off every EOT decision vs. slightly more WS overhead).
- [ ] The LiveKit `AudioSource` is created with a **300ms buffer**
      (`transport-livekit/src/voice-agent.ts`) — verify first frames aren't queuing behind it
      before playout starts.
- [ ] **Region colocation** of engine workers with LiveKit + Deepgram + Cartesia endpoints; three
      WebSocket RTTs sit on every turn. Measure per-service RTT and pick regions deliberately.
- [x] **Latency budgets as tests.** Per-stage p50/p95 targets (e.g. `vad_end→first_audio` ≤ 350ms
      p50) with regression alerts. All the per-stage distributions already exist in
      `shared/metrics.ts`; they currently inform nothing automatically.
      *(Done: `shared/latency-budgets.ts` — six-stage budget table evaluated per call at shutdown;
      violations logged and emitted as `mimic.latency_budget.violation` with stage + percentile.)*

---

## 2. Turn-taking

- [x] **Content-aware barge escalation.** Today a caller saying "yeah… yeah, okay—" for >350ms
      triggers a full interrupt even though it's assent — escalation is purely duration-based.
      Before escalating from soft-pause, run the partial transcript through the same filler/assent
      fast-path the promotion classifier uses (the 17-word strip list). Pure string check, no LLM,
      kills the most jarring wrongful-interrupt case.
      *(Done: `shared/filler-speech.ts` + guarded `substantiveSpeechMs` timeout in `turn-actor.ts`,
      capped at two holds; `filler_held` barge outcome recorded in metrics.)*
- [x] **Restart, don't resume, after long pauses.** The pause gate resumes buffered audio mid-stream
      regardless of yield length. Past ~700ms, discard the buffered remainder of the current
      sentence and re-synthesize from the last sentence boundary with a restart connective
      ("So— yeah, as I was saying…"). Chunker knows the boundaries; playback tracker knows what was
      heard.
      *(Done: soft-pauses >700ms tear down the paused pipeline and re-enter `executing` with a
      `fixed_text` strategy — "So — as I was saying:" + remainder from the last sentence boundary;
      the commit keeps the original draft text; one restart per turn; `restarted` soft-pause
      outcome in metrics.)*
- [ ] **Position-aware yielding.** A barge 200ms before the turn would naturally end should let the
      clause finish; a barge right after onset should yield near-instantly. Modulate the flat
      `yieldWindowMs = 80` by position-in-draft (remaining length is known from the tracker).
- [x] **Adaptive conversation physics (heuristic, per-caller).** The signals are already recorded:
      Flux `TurnResumed` (we stepped on the caller), soft-pause outcomes (`resumed` vs
      `escalated_to_interrupt`), barge counts, words-per-turn timing. v1 controller: two
      `TurnResumed` events or a mid-thought interrupt → raise `eotTimeoutMs`, widen
      `substantiveSpeechMs`, lengthen the silence watchdog, and inject one control-block line
      ("this caller pauses mid-sentence — wait for them"). Fixes the most damaging failure mode
      (talking over slow speakers) with zero training.
      *(Done: `turn/conversation-physics.ts` — one-way slow-caller latch on 2× TurnResumed, 1×
      soft-pause escalation, or 2× early barges; reconfigures Flux EOT, widens the escalation
      timer and watchdog, disables early commit, appends a control-block line.)*
- [ ] **Context-sensitive silence watchdog.** 6s flat is wrong in both directions — longer patience
      after the agent asks a hard question, shorter after a statement. Vary check-in phrasing via
      compiler-generated persona-matched lines instead of numbered escalations.

---

## 3. Speculation

- [ ] **Continuous speculation, latest-wins.** Speculation currently launches only on
      `EagerEndOfTurn`. Launch on Flux `Update`s once the partial ends at a plausible completion
      point, superseding prior drafts (`latestWinsQueue` in `shared/task.ts` already exists). Bound
      by a per-call speculation budget; watch `speculation_hit_rate`.
- [ ] **One-turn-ahead speculation.** While the agent asks "2pm, or is Thursday better?", the reply
      space is ~{2pm, Thursday, neither}. Pre-generate and pre-synthesize responses for top branches
      *while the agent is still speaking*; the promotion classifier picks the matching branch or
      falls through to fresh. Cartesia sockets multiplex contexts, so branches need no new
      connections. Appointment-confirmation calls are exactly this shape — this is
      negative-latency turn preparation nobody ships.
- [ ] **Tune thresholds from the corpus.** `eager_eot_threshold=0.3` / `eot_threshold=0.5` are
      guesses. The recorded speculation funnel contains the operating curve — sweep offline
      against replay data (§6.1) and pick the point where wasted generations stop buying hit rate.

---

## 4. Naturalness (no clips, no training)

- [x] **Implement `[end-call]`.** `extractTtsControlTags` in `audio/tts-sanitizer.ts` is a stub
      (`endCallRequested: false` unconditionally) — the agent cannot say goodbye and hang up; every
      call ends via silence watchdog or callee hangup. Endings are what people remember (peak-end
      rule) and the downstream plumbing (`requestCallHangup`, `source: 'end_call_tag'`) already
      exists. Cheapest big naturalness win in the codebase.
      *(Done: tag extraction incl. variants, flag threaded through the eager/promotion path,
      prompt teaching in `voice-api-template.md`, `endCallEnabled` config flag.)*
- [ ] **Reconcile emotion.** The goal compiler teaches `<emotion value="…"/>` tags; the sanitizer
      whitelist (`/^(break|spell)$/i`) strips them before Cartesia. Either wire through whatever
      Sonic 3.5 actually supports (API-level speed/emotion controls rather than inline SSML) or
      remove from `goal-compiler.md` and stop paying tokens for dead instructions. **Speed alone is
      worth wiring:** slightly slower on number/email readbacks is a very human pattern.
- [ ] **Latch short confirmations.** When eager validates and the response is a short affirmative,
      flush with near-zero gap. Humans latch turns on predictable completions; the polite 300ms
      pause on "…is that okay?" → "Yes!" is itself a tell. The presynthesized path + conservative
      promotion classifier make this safe here and nowhere else.
- [ ] **Deliberate onset variance.** Don't only minimize latency — humans take *longer* before
      weighty answers. A prompted "hmm <break/>" before bad-news or complex responses reads as
      thought. Variance in onset, not just minimum, is what sounds alive.
- [x] **Fix ambience in production.** `transport-livekit/src/ambience-track.ts` shells out to
      ffmpeg via `execSync`, and ffmpeg is not installed in either Dockerfile — production calls
      likely run without the room tone that was built. Decode at build time or add ffmpeg to images.
      *(Done: ffmpeg added to both Dockerfiles; build script now copies the mp3 into `build/audio`.)*
- [ ] **Backchannel coverage.** Arlo's voice ID has no backchannel clip directory (would throw /
      falls back to `'Sarah'`), and the referenced `generate-backchannel-clips.ts` script doesn't
      exist in this repo. Regenerate per configured voice through Cartesia at build time — generated
      assets, not hand-recorded clips, consistent with the no-canned-clips rule.
- [ ] **Compliance note:** as naturalness compounds, calls will genuinely fool people. Keep it
      inside the `aiDisclosure` envelope — that's the ethical line and, increasingly, the
      regulatory one (per-state consent/disclosure rules).

---

## 5. Call-world robustness

Mostly catch-up vs. Bland/Retell/Vapi, but prerequisite for everything in §7–8.

- [ ] **Voicemail / answering-machine detection.** Today `waitUntilAnswered` is the only gate — a
      voicemail greeting is treated as a live caller. Classifier over the first seconds via the
      existing `listen-transcriber`; outcomes: leave message / hang up / schedule retry.
- [ ] **DTMF send + IVR navigation.** No DTMF anywhere in the codebase. LiveKit SIP supports it.
      Expose as a built-in tool; treat phone trees as an environment the agent navigates (this is
      where you can leapfrog incumbents, whose IVR handling is scripted).
- [ ] **Hold detection.** Detect hold music / "please wait", mute the director, keep listening,
      resume on human return.
- [ ] **Director failover / retry.** A director stream error currently discards the turn and the
      agent goes silent until the caller speaks or the 6s watchdog fires. Add one retry, then
      cross-provider fallback (OpenAI ↔ Anthropic are both already wired in
      `director-provider.ts`).
- [ ] **Inbound calls — make an explicit decision.** The engine is direction-agnostic; only
      dialing/dispatch is missing. Doubles the addressable market; decide deliberately rather than
      by default.

---

## 6. The quality loop

The compounding bets. Order matters: replay enables everything else.

### 6.1 Branchable call replay

The engine is already event-sourced (caller/VAD/playback events through XState) and the test suite
already drives the machine with mock runtimes and fake sockets (`test/support/`).

- [x] **Persist the full engine event log per call** (JSONL to S3 beside the recording; lift the
      80-entry transcript event cap for persistence).
      *(Done: uncapped per-call recorder in `engine/src/replay/event-log.ts` taps every machine
      input, metric, physics change, early-commit outcome, and tool lifecycle event; exposed on
      `orchestrator.close()`; uploaded to `call-events/<callId>.jsonl` beside the recording and
      recorded in `api_calls.event_log_path`.)*
- [x] **Deterministic replay harness** on top of the existing test mocks with virtual time.
      *(Done: `engine/src/replay/replay-harness.ts` re-drives the CallMachine runtime from a
      recorded log with a scripted director, fake TTS/transport, and mock timers; fixture
      regression test in `replay-harness.test.ts`.)*
- [x] **Timing counterfactuals first — they need no simulation.** "Would this interrupt have
      resolved as a short pause at `substantiveSpeechMs=500`?" is directly computable from recorded
      VAD/playback timelines. Sweep thresholds across the whole corpus offline; choose empirically.
      *(Done: `engine/src/replay/timing-counterfactuals.ts` — barge-episode sweeps, early-commit
      guard sweeps with wrong-transcript risk, caller-gap distributions; corpus CLI at
      `server/src/scripts/sweep-thresholds.ts` reads S3 or a local dir.)*
- [ ] **Branching with an LLM-simulated caller later.** Honest framing: exact replay up to the
      divergence point, simulation after (the real caller's counterfactual responses are
      unknowable). Persona inferred from the real transcript.
- [ ] **Every bad production call becomes a permanent regression test.**

### 6.2 Evals as a compile artifact + audio self-play

- [x] Extend the goal compiler to also emit **adversarial caller personas + a scoring rubric**
      (confused elderly caller, constant interrupter, out-of-order info, hostile "who is this?",
      wrong number).
      *(Done: `server/src/eval-generator.ts` rides behind every compile — 4-6 personas across
      distinct stress axes + weighted rubric derived from the AgentSpec, stored in
      `api_agents.evals`.)*
- [x] **Agent-vs-agent calls at the audio level** — synthetic caller (LLM + TTS, optional noise
      injection) over a local `AudioTransport` loop, exercising Flux EOT, barge-in, speculation,
      sanitizer — not text-level simulation. Score with LLM judge + existing per-turn metrics.
      *(Done: `server/src/scripts/self-play.ts` — loopback transport with realtime pacing, persona
      LLM + Cartesia voice as the caller, Flux EOT on the agent's own audio deciding when the
      caller replies, rubric judge on the resulting transcript.)*
- [x] Attach eval results to the `configHash` — an agent ships with its own test suite; "passed
      47/50 stress calls before dialing a human" is a product feature nobody has.
      *(Done: self-play results + event logs written under `self-play-results/<configHash>/`.)*

### 6.3 Typed AgentSpec — contract sidecar, not prompt replacement

Keep the "brief it like a human" DX and the prose `compiledPrompt`. Add a machine-checkable
sidecar the compiler emits alongside it:

- [x] `mustCollect`, `mustVerify`, `writeActions` (+ confirmation requirements),
      `successCriteria`, `prohibited`.
      *(Done: `server/src/agent-spec.ts` — LLM emits the judgment fields, `writeActions` built
      deterministically from tool definitions; stored in `api_agents.agent_spec`.)*
- [x] Feed it to existing injection points: tool watcher gets `mustVerify` (today: generic
      categories), control block gets progress ("collected 3 of 5 fields"), extraction gets
      `successCriteria` (the `success_condition` column exists and is never written), replay
      judges score against it.
      *(Done: watcher receives `mustVerify` as a named-values contract section; every turn
      control block carries an `<agent_contract>` block (mustCollect/mustVerify/confirmation
      actions/prohibited — static contract, not yet live collected-field progress); extraction
      judges `successCriteria`; the self-play judge scores against the spec.)*
- [x] Compile-time lint: verify the compiled prompt satisfies its own spec before caching.
      *(Done: `lintAgentSpec` cross-checks spec fields against declared data/results/tools and the
      compiled prompt text; warnings logged at compile.)*

### 6.4 Self-improvement flywheel (no training)

- [ ] Record → judge (LLM + metrics) → propose prompt revision (compiler takes "call learnings"
      as input) → test against replay corpus + generated evals → deploy the new compiled prompt
      for that `configHash` only if it wins. Requires §0 tool-call persistence and per-call
      cost/latency accounting in the DB.

---

## 7. Verified actions

~70% already exists: the director never calls tools; the watcher enforces read-back confirmation
for verification-sensitive values before WRITE tools, normalizes spoken values, dedupes execution
signatures, caps concurrency. Harden, don't rebuild:

- [x] **Deterministic post-LLM gate:** cross-check WRITE args against prior READ results (proposed
      "Tuesday 3PM" must appear in the `checkCalendar` output before `bookAppointment` may fire).
      *(Done: `engine/src/intelligence/tools/write-gate.ts` — token-coverage matching of WRITE args
      against READ results and caller utterances, spoken-number aware; blocked writes return an
      instructive error to the watcher instead of firing.)*
- [x] **Evidence spans:** store the exact transcript quote constituting confirmation with each
      WRITE execution.
      *(Done: the gate emits `ToolEvidenceSpan`s (source, quote, matched arg) carried on the audit
      trail.)*
- [x] **Audit trail:** proposed → approved → executed → result, persisted (depends on §0
      `tool_calls` fix).
      *(Done: proposed → gate → executed events in the call event log and persisted to
      `api_calls.tool_audit`.)*
- [x] **Per-agent action allowlists**; `requiresConfirmation` option on the SDK `tool()`.
      *(Done: runtime rejects tools outside the agent's definition list; `tool()` accepts
      `kind: 'write'` + `requiresConfirmation`, surfaced to the watcher as
      "[WRITE, confirmation required]".)*
- [x] **Send real JSON Schema for tools.** The SDK's `introspectTools` flattens parameters to
      description strings; the watcher rebuilds types by guesswork. Ship the actual schema.
      Also: MCP tools currently skip validation entirely (`z.record(z.unknown())`).
      *(Done: `introspectTools` emits real JSON Schema via zod-to-json-schema; MCP tools forward
      their native `inputSchema` and classify read/write from MCP annotations; the engine
      validates+coerces args against the schema before execution.)*

---

## 8. Product expansion

- [ ] **Persistent outcome orchestration.** The unit of work becomes "get this appointment
      confirmed", not "make a call": an `outcomes` table with a small state machine (attempts,
      next-action-at, calling-hours policy), BullMQ delayed jobs for retries (note: current
      `attempts: 2` is inert — `runCall` swallows all errors), SDK handle streaming events across
      calls. Depends on voicemail detection (§5) to distinguish no-answer / voicemail / busy.
- [ ] **Multi-call primitives:** race N calls (call five restaurants, first confirmed booking wins,
      politely exit the rest — the promise-based `MimicCall` handle is begging for this); chaining
      with shared memory (call pharmacy → call patient back); **warm transfer with a whispered
      agent briefing** to the human before bridging.
- [ ] **Cross-call memory.** Per-recipient profiles keyed by phone number (per tenant): the
      entities/summaries already extracted per call, persisted and injected via control block
      ("Last time you said Thursdays work best"). Privacy-sensitive; make it opt-in.

---

## 9. Platform hygiene & housekeeping

**Server correctness**

- [x] Prompt-cache hash includes full `data` *values* (`routes/calls.ts` `hashPromptConfig`),
      contradicting the documented design ("data keys compiled, values injected at runtime") — every
      value change forces a ~30s recompile. Hash keys only.
      *(Done: hash covers data keys only; compiler now sees keys/shape with values masked; values
      are stored per call in `api_calls.call_data` and injected at runtime via a `<data>` block in
      the opening context and every turn control block. Migration applied to prod.)*
- [ ] Rate limiter is in-memory and the 10-concurrent-calls check is check-then-insert racy —
      breaks under multiple API replicas. Move to Redis.
- [ ] Fire-and-forget compile block means a crashed API process strands calls in `pending` forever.
      Add a janitor/reaper for stuck `pending`/`in_progress` rows.
- [ ] Webhooks: unsigned (secret never passed), unregisterable via API, no retry,
      `webhook_delivered_at` never written. Either finish or remove.
- [ ] Key management API (create/revoke/rotate) — currently CLI script only; `tenant_id` exists but
      is unenforced.
- [ ] Extraction model is hardcoded `gpt-4o` (`result-extractor.ts`) — inconsistent with the rest of
      the stack; extraction schema supports only flat string/number/boolean (nested Zod silently
      degrades to strings).
- [ ] `OPENAI_API_KEY` is required even in Anthropic director mode (background models are always
      OpenAI) — document or decouple.

**Dead code / stale docs**

- [ ] Remove or wire: `jobs/call-processor.ts` (unused sandboxed processor), `outbound-call.ts`
      `runOutboundCall`, `modelConfig.helper` / `modelConfig.webSearch`, `director.generateDraft`,
      `executingTools` (always `[]`).
- [ ] Fix stale comments: `watcher.ts` header claims Claude Sonnet (actual: gpt-5.5 via Responses),
      engine README says "Groq" for the promotion classifier (actual: gpt-5.4-mini),
      `frame-align.ts` "100ms chunks" comment (actual: 20ms / 1920 bytes).
- [ ] Committed `build/` output, `tsbuildinfo`, `.DS_Store`; root `package.json` npm-init
      boilerplate (ISC vs MIT mismatch).

**Testing & observability**

- [ ] Zero tests in `packages/server` (SIP, queue, routes, auth, extraction) and
      `packages/transport-livekit`; SDK has 2 files; engine is strong (315 cases). No CI at all —
      add GitHub Actions running build/typecheck/test.
- [ ] No request IDs (the SDK's `ApiError` expects them), no tracing, no metrics endpoint on the
      API. Engine metrics go to optional Sentry that nothing configures. Persist per-call
      cost/latency accounting (needed for §6.4).

---

## Suggested sequencing

**Week one (small, immediately audible/critical):**
P0 items (§0) · `[end-call]` · content-aware barge escalation · short-opener prompt change ·
ffmpeg in Docker · prompt-cache hash fix.

**Next (structural latency + turn-taking):** ✅ done
Early commit + clause-level first flush (biggest p50 mover) · question-aware boundaries ·
adaptive physics v1 · pre-synthesized greeting · predicted outputs · restart-don't-resume ·
latency budgets.

**Then (the compounding bets):** ✅ done
Event-log persistence → replay harness → timing counterfactuals → threshold sweeps ·
evals-at-compile + audio self-play · AgentSpec sidecar · verified-actions hardening.

**The frontier:**
One-turn-ahead speculation · continuous speculation · outcome orchestration · multi-call
primitives · cross-call memory · self-improvement flywheel.
