import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

import { createEarlyCommitController, normalizeTranscript, type EarlyCommitWorld } from './early-commit.js'

function buildHarness(overrides: { guardMs?: number | null } = {}) {
	const world: EarlyCommitWorld = {
		machineInTurn: false,
		isClosing: false,
		eagerReady: false,
		eagerBasisTranscript: null,
	}
	const commits: Array<{ transcript: string; confidence: number }> = []
	const fired: Array<{ transcript: string; sinceVadEndMs: number }> = []
	const blocked: string[] = []
	let guardMs: number | null = overrides.guardMs === undefined ? 240 : overrides.guardMs

	const controller = createEarlyCommitController({
		guardMsFor: () => guardMs,
		getWorld: () => ({ ...world }),
		commit: (transcript, confidence) => commits.push({ transcript, confidence }),
		onFired: (info) => fired.push(info),
		onBlocked: (reason) => blocked.push(reason),
	})

	return {
		world,
		commits,
		fired,
		blocked,
		controller,
		setGuard(value: number | null) {
			guardMs = value
		},
	}
}

/** Walks the harness into the canonical pre-fire state: caller spoke,
 * eager boundary fired, draft prepared, VAD reports silence. */
function primeReadyDraft(h: ReturnType<typeof buildHarness>, transcript = 'Yes, that works for me.') {
	h.controller.callerTurnStart()
	h.controller.vadSpeechStart()
	h.controller.callerUpdate(transcript)
	h.controller.callerEagerTurn(transcript, 0.8)
	h.world.eagerReady = true
	h.world.eagerBasisTranscript = transcript
	h.controller.vadSpeechEnd()
}

describe('early-commit controller', () => {
	beforeEach(() => {
		// A positive epoch — the controller treats t=0 as "no VAD end yet".
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
	})
	afterEach(() => {
		mock.timers.reset()
	})

	it('fires a synthetic commit after the guard interval', () => {
		const h = buildHarness()
		primeReadyDraft(h)
		assert.equal(h.commits.length, 0)
		mock.timers.tick(239)
		assert.equal(h.commits.length, 0)
		mock.timers.tick(1)
		assert.equal(h.commits.length, 1)
		assert.equal(h.commits[0].transcript, 'Yes, that works for me.')
		assert.equal(h.commits[0].confidence, 0.8)
		assert.equal(h.fired.length, 1)
		assert.ok(h.fired[0].sinceVadEndMs >= 240)
	})

	it('does not fire while the draft is missing, then fires on eagerDraftReady', () => {
		const h = buildHarness()
		h.controller.callerTurnStart()
		h.controller.vadSpeechStart()
		h.controller.callerUpdate('Sure, go ahead.')
		h.controller.callerEagerTurn('Sure, go ahead.', 0.7)
		h.controller.vadSpeechEnd()
		mock.timers.tick(240)
		assert.equal(h.commits.length, 0)
		assert.ok(h.blocked.includes('no_draft'))

		// Draft finishes 600ms into the silence — commit immediately.
		mock.timers.tick(360)
		h.world.eagerReady = true
		h.world.eagerBasisTranscript = 'Sure, go ahead.'
		h.controller.eagerDraftReady()
		assert.equal(h.commits.length, 1)
	})

	it('eagerDraftReady inside the guard window waits for the guard', () => {
		const h = buildHarness()
		h.controller.vadSpeechStart()
		h.controller.callerEagerTurn('Okay.', 0.9)
		h.controller.vadSpeechEnd()
		mock.timers.tick(100)
		h.world.eagerReady = true
		h.world.eagerBasisTranscript = 'Okay.'
		h.controller.eagerDraftReady()
		assert.equal(h.commits.length, 0)
		mock.timers.tick(140)
		assert.equal(h.commits.length, 1)
	})

	it('a longer partial than the draft basis blocks the commit', () => {
		const h = buildHarness()
		primeReadyDraft(h, 'I think Tuesday')
		h.controller.callerUpdate('I think Tuesday actually no Wednesday')
		mock.timers.tick(240)
		assert.equal(h.commits.length, 0)
		assert.ok(h.blocked.includes('partial_mismatch'))
	})

	it('punctuation and casing differences do not block the match', () => {
		const h = buildHarness()
		primeReadyDraft(h, 'Yes, that works.')
		h.controller.callerUpdate('yes that works')
		mock.timers.tick(240)
		assert.equal(h.commits.length, 1)
	})

	it('VAD speech restarting cancels the pending commit', () => {
		const h = buildHarness()
		primeReadyDraft(h)
		mock.timers.tick(100)
		h.controller.vadSpeechStart()
		mock.timers.tick(500)
		assert.equal(h.commits.length, 0)
	})

	it('caller_turn_start and caller_turn_resumed cancel the pending commit', () => {
		for (const cancel of ['callerTurnStart', 'callerTurnResumed'] as const) {
			const h = buildHarness()
			primeReadyDraft(h)
			h.controller[cancel]()
			mock.timers.tick(1000)
			assert.equal(h.commits.length, 0, `${cancel} should cancel`)
		}
	})

	it('a real Flux final cancels the pending commit', () => {
		const h = buildHarness()
		primeReadyDraft(h)
		h.controller.callerTurnComplete()
		mock.timers.tick(1000)
		assert.equal(h.commits.length, 0)
	})

	it('never fires while the machine is in a turn', () => {
		const h = buildHarness()
		primeReadyDraft(h)
		h.world.machineInTurn = true
		mock.timers.tick(240)
		assert.equal(h.commits.length, 0)
		assert.ok(h.blocked.includes('in_turn'))
	})

	it('never fires when disabled (open question / slow-caller physics)', () => {
		const h = buildHarness({ guardMs: null })
		primeReadyDraft(h)
		mock.timers.tick(5000)
		assert.equal(h.commits.length, 0)
	})

	it('never fires while closing', () => {
		const h = buildHarness()
		primeReadyDraft(h)
		h.world.isClosing = true
		mock.timers.tick(240)
		assert.equal(h.commits.length, 0)
		assert.ok(h.blocked.includes('closing'))
	})

	it('close() stops everything', () => {
		const h = buildHarness()
		primeReadyDraft(h)
		h.controller.close()
		mock.timers.tick(1000)
		assert.equal(h.commits.length, 0)
	})

	it('fires at most once per utterance', () => {
		const h = buildHarness()
		primeReadyDraft(h)
		mock.timers.tick(240)
		assert.equal(h.commits.length, 1)
		// Draft still "ready" and silence continues — no double commit.
		h.controller.eagerDraftReady()
		mock.timers.tick(1000)
		assert.equal(h.commits.length, 1)
	})

	it('ignores its own synthetic events during commit', () => {
		const h = buildHarness()
		const controller = createEarlyCommitController({
			guardMsFor: () => 240,
			getWorld: () => ({
				machineInTurn: false,
				isClosing: false,
				eagerReady: true,
				eagerBasisTranscript: 'Sounds good.',
			}),
			// Mimics the runtime: the synthetic caller_turn_complete re-enters
			// the controller synchronously.
			commit: (transcript, confidence) => {
				h.commits.push({ transcript, confidence })
				controller.callerTurnComplete()
				controller.vadSpeechEnd()
			},
		})
		controller.vadSpeechStart()
		controller.callerEagerTurn('Sounds good.', 0.9)
		controller.vadSpeechEnd()
		mock.timers.tick(240)
		assert.equal(h.commits.length, 1)
		// The nested vadSpeechEnd must not have re-armed a second commit.
		mock.timers.tick(2000)
		assert.equal(h.commits.length, 1)
	})
})

describe('normalizeTranscript', () => {
	it('strips punctuation, casing, and extra whitespace', () => {
		assert.equal(normalizeTranscript('  Yes,  that   WORKS!  '), 'yes that works')
		assert.equal(normalizeTranscript('...'), '')
	})
})
