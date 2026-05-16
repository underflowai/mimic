import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createBackchannelEngine, type BackchannelToken } from './engine.js'

interface TestEngineOverrides {
	classifyResult?: BackchannelToken | null | ((transcript: string) => Promise<BackchannelToken | null>)
	minSpeechGateMs?: number
	refractoryMs?: number
	minWordCount?: number
	eotConfidenceThreshold?: number
	nowMs?: () => number
}

function createTestEngine(overrides?: TestEngineOverrides) {
	const fired: BackchannelToken[] = []
	const cr = overrides?.classifyResult
	const classifier =
		typeof cr === 'function' ? cr : async () => (cr === undefined ? ('mm-hmm' as BackchannelToken) : cr)
	const engine = createBackchannelEngine(
		{
			onFire: (token) => fired.push(token),
			classifyBackchannel: classifier,
			nowMs: overrides?.nowMs,
		},
		{
			minSpeechGateMs: overrides?.minSpeechGateMs ?? 0,
			refractoryMs: overrides?.refractoryMs ?? 100,
			minWordCount: overrides?.minWordCount ?? 1,
			eotConfidenceThreshold: overrides?.eotConfidenceThreshold ?? 1.0,
		},
	)

	const start = () =>
		engine.send({ type: 'caller_turn_event', event: { type: 'turn_start', transcript: '', confidence: 0 } })
	const update = (transcript: string, eotConfidence: number) =>
		engine.send({ type: 'caller_turn_event', event: { type: 'update', transcript, confidence: eotConfidence } })
	const eagerTurn = (transcript: string, eotConfidence: number) =>
		engine.send({
			type: 'caller_turn_event',
			event: { type: 'eager_turn', transcript, confidence: eotConfidence },
		})
	const end = () =>
		engine.send({
			type: 'caller_turn_event',
			event: { type: 'turn_complete', transcript: '', confidence: 1 },
		})

	return { engine, fired, start, update, eagerTurn, end }
}

function wait(ms: number) {
	return new Promise<void>((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Hard gates
// ---------------------------------------------------------------------------

describe('hard gates', () => {
	it('blocks when speech duration is too short', async () => {
		let now = 1000
		const { fired, start, update } = createTestEngine({
			minSpeechGateMs: 3000,
			nowMs: () => now,
		})
		start()
		now = 1500
		update('This is a long enough transcript for the word gate.', 0.9)
		await wait(50)
		assert.equal(fired.length, 0)
	})

	it('allows when speech duration exceeds gate', async () => {
		let now = 1000
		const { fired, start, update } = createTestEngine({
			minSpeechGateMs: 3000,
			nowMs: () => now,
		})
		start()
		now = 5000
		update('This is a long enough transcript for the word gate.', 0.9)
		await wait(50)
		assert.equal(fired.length, 1)
	})

	it('blocks when last fire was too recent (refractory)', async () => {
		let now = 1000
		const { fired, start, update } = createTestEngine({
			refractoryMs: 4000,
			nowMs: () => now,
		})
		start()
		update('First backchannel opportunity right here.', 0.9)
		await wait(50)
		assert.equal(fired.length, 1)

		now = 2000
		update('Second opportunity should be blocked by refractory.', 0.9)
		await wait(50)
		assert.equal(fired.length, 1)
	})

	it('allows after refractory period expires', async () => {
		let now = 1000
		const { fired, start, update } = createTestEngine({
			refractoryMs: 100,
			nowMs: () => now,
		})
		start()
		update('First backchannel opportunity right here.', 0.9)
		await wait(50)
		assert.equal(fired.length, 1)

		now = 2000
		update('Second opportunity after refractory expires.', 0.9)
		await wait(120)
		update('Second opportunity after refractory has elapsed.', 0.9)
		await wait(50)
		assert.equal(fired.length, 2)
	})

	it('blocks when transcript has too few words', async () => {
		const { fired, start, update } = createTestEngine({ minWordCount: 4 })
		start()
		update('Too short', 0.9)
		await wait(50)
		assert.equal(fired.length, 0)
	})

	it('allows when transcript meets word count', async () => {
		const { fired, start, update } = createTestEngine({ minWordCount: 4 })
		start()
		update('This has enough words now.', 0.9)
		await wait(50)
		assert.equal(fired.length, 1)
	})

	it('blocks during post-interrupt suppression window', async () => {
		const { engine, fired, start, update } = createTestEngine()
		engine.send({
			type: 'turn_outcome',
			outcome: {
				kind: 'interrupted',
				turnId: 1,
				transcript: 'hi',
				interruptContext: { fullDraft: 'draft', sentMs: 100, heardPortion: 'draft' },
				reason: 'caller_started_speaking',
			},
		})
		start()
		update('Long sentence that should not fire yet.', 0.9)
		await wait(50)
		assert.equal(fired.length, 0)
	})

	it('blocks when handleTurnStart has not been called', async () => {
		const { fired, update } = createTestEngine()
		update('No turn started so this should not fire.', 0.9)
		await wait(50)
		assert.equal(fired.length, 0)
	})
})

// ---------------------------------------------------------------------------
// eager_turn handling
// ---------------------------------------------------------------------------

describe('eager_turn handling', () => {
	it('eager_turn event triggers classification like update', async () => {
		const { fired, start, eagerTurn } = createTestEngine()
		start()
		eagerTurn('This is a long enough transcript for eager turn classification.', 0.1)
		await wait(50)
		assert.equal(fired.length, 1)
	})

	it('eager_turn updates lastTranscript for subsequent classification', async () => {
		const classifiedTranscripts: string[] = []

		const { start, update, eagerTurn } = createTestEngine({
			refractoryMs: 0,
			classifyResult: (transcript) => {
				classifiedTranscripts.push(transcript)
				return Promise.resolve('yeah' as BackchannelToken)
			},
		})

		start()
		update('First update transcript from caller here.', 0.1)
		await wait(50)
		assert.equal(classifiedTranscripts[0], 'First update transcript from caller here.')

		eagerTurn('Eager turn replaces the previous transcript now.', 0.1)
		await wait(50)
		assert.equal(classifiedTranscripts[1], 'Eager turn replaces the previous transcript now.')
	})
})

// ---------------------------------------------------------------------------
// EOT confidence gate
// ---------------------------------------------------------------------------

describe('eot confidence gate', () => {
	it('blocks when EOT confidence is above threshold', async () => {
		const { fired, start, update } = createTestEngine({ eotConfidenceThreshold: 0.3 })
		start()
		update('We have about 200 vehicles in the fleet.', 0.5)
		await wait(50)
		assert.equal(fired.length, 0)
	})

	it('allows when EOT confidence is below threshold', async () => {
		const { fired, start, update } = createTestEngine({ eotConfidenceThreshold: 0.3 })
		start()
		update('We have about 200 vehicles in the fleet.', 0.1)
		await wait(50)
		assert.equal(fired.length, 1)
	})

	it('blocks when confidence rises during LLM call (post-gate)', async () => {
		let eotConfidence = 0.1
		let resolveClassify!: (v: BackchannelToken | null) => void

		const { fired, start, update } = createTestEngine({
			eotConfidenceThreshold: 0.3,
			classifyResult: () =>
				new Promise((r) => {
					resolveClassify = r
				}),
		})

		start()
		update('Caller is mid-speech with low confidence.', eotConfidence)
		await wait(10)

		eotConfidence = 0.6
		update('Caller is now winding down their sentence.', eotConfidence)

		resolveClassify('right')
		await wait(50)
		assert.equal(fired.length, 0, 'should not fire because EOT confidence rose during LLM call')
	})

	it('allows when confidence stays low during LLM call', async () => {
		let resolveClassify!: (v: BackchannelToken | null) => void

		const { fired, start, update } = createTestEngine({
			eotConfidenceThreshold: 0.3,
			classifyResult: () =>
				new Promise((r) => {
					resolveClassify = r
				}),
		})

		start()
		update('Caller is mid-speech with low confidence.', 0.05)
		await wait(10)

		update('Caller continues speaking with low confidence.', 0.08)

		resolveClassify('right')
		await wait(50)
		assert.equal(fired.length, 1)
		assert.equal(fired[0], 'right')
	})

	it('resets EOT confidence on speechEnd', async () => {
		const { fired, start, update, end } = createTestEngine({ eotConfidenceThreshold: 0.3 })

		start()
		update('High confidence at end of first turn.', 0.7)
		await wait(50)
		assert.equal(fired.length, 0)

		end()
		start()
		update('New turn starts fresh with low confidence.', 0.05)
		await wait(50)
		assert.equal(fired.length, 1)
	})
})

// ---------------------------------------------------------------------------
// In-flight guard
// ---------------------------------------------------------------------------

describe('in-flight guard', () => {
	it('does not fire concurrent LLM calls', async () => {
		const classifyCalls: string[] = []
		let resolveFirst!: (v: BackchannelToken | null) => void
		let callCount = 0

		const { fired, start, update } = createTestEngine({
			classifyResult: (transcript) => {
				classifyCalls.push(transcript)
				callCount++
				if (callCount === 1) {
					return new Promise((r) => {
						resolveFirst = r
					})
				}
				return Promise.resolve('yeah' as BackchannelToken)
			},
		})

		start()
		update('First call that will be slow to resolve.', 0.9)
		await wait(10)
		update('Second call while first is in flight.', 0.9)
		await wait(10)

		assert.equal(classifyCalls.length, 1, 'second call should be blocked')

		resolveFirst('right')
		await wait(50)
		assert.equal(fired.length, 1)
		assert.equal(fired[0], 'right')
	})
})

// ---------------------------------------------------------------------------
// Classifier results
// ---------------------------------------------------------------------------

describe('classifier results', () => {
	it('fires when classifier returns a valid token', async () => {
		const { fired, start, update } = createTestEngine({ classifyResult: 'yeah' })
		start()
		update('We have about 200 vehicles in the fleet,', 0.9)
		await wait(50)
		assert.equal(fired.length, 1)
		assert.equal(fired[0], 'yeah')
	})

	it('does not fire when classifier returns null (skip)', async () => {
		const { fired, start, update } = createTestEngine({ classifyResult: null })
		start()
		update('Can you help me with that?', 0.9)
		await wait(50)
		assert.equal(fired.length, 0)
	})

	it('does not fire when classifier throws', async () => {
		const { fired, start, update } = createTestEngine({
			classifyResult: () => Promise.reject(new Error('network error')),
		})
		start()
		update('Something that triggers a network failure.', 0.9)
		await wait(50)
		assert.equal(fired.length, 0)
	})

	it('rechecks turn phase after LLM returns', async () => {
		const { fired, start, update } = createTestEngine({
			classifyResult: async () => {
				return 'right' as BackchannelToken
			},
		})
		start()
		update('Aurora started responding during LLM call.', 0.9)
		await wait(50)
		assert.equal(fired.length, 1, 'fires because suppression is event-driven, not turn-phase callback gated')
	})
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
	it('handleSpeechEnd resets state so next turn requires handleTurnStart', async () => {
		const { fired, start, update, end } = createTestEngine()
		start()
		update('First turn fires a backchannel here.', 0.9)
		await wait(50)
		const countAfterFirst = fired.length
		assert.ok(countAfterFirst >= 1)

		end()
		update('Should not fire without handleTurnStart.', 0.9)
		await wait(50)
		assert.equal(fired.length, countAfterFirst)
	})

	it('can restart after speechEnd', async () => {
		const { fired, start, update, end } = createTestEngine({ refractoryMs: 0 })
		start()
		update('First turn fires a backchannel here.', 0.9)
		await wait(50)
		const firstRound = fired.length

		end()
		start()
		update('Second turn also fires a backchannel.', 0.9)
		await wait(50)
		assert.ok(fired.length > firstRound)
	})

	it('passes the correct token through onFire', async () => {
		const onFire = mock.fn((_token: BackchannelToken) => {})
		const engine = createBackchannelEngine(
			{
				onFire,
				classifyBackchannel: async () => 'got-it',
			},
			{ minSpeechGateMs: 0, refractoryMs: 0, minWordCount: 1, eotConfidenceThreshold: 1.0 },
		)
		engine.send({
			type: 'caller_turn_event',
			event: { type: 'turn_start', transcript: '', confidence: 0 },
		})
		engine.send({
			type: 'caller_turn_event',
			event: { type: 'update', transcript: 'Something specific about the policy.', confidence: 0.9 },
		})
		await wait(50)
		assert.equal(onFire.mock.calls.length, 1)
		assert.equal(onFire.mock.calls[0]!.arguments[0], 'got-it')
	})
})
