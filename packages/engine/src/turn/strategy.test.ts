import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { selectStrategy, type CallerCompleteInput, type EagerSnapshot, type WorldSnapshot } from './strategy.js'

const input: CallerCompleteInput = { transcript: 'what are the rates', confidence: 0.9, controlBlock: 'test block' }

function makeWorld(overrides?: Partial<WorldSnapshot>): WorldSnapshot {
	return {
		isClosing: false,
		inSoftPause: false,
		backchannelResumedPending: false,
		lastTurnWasInterrupted: false,
		eagerSnapshot: null,
		...overrides,
	}
}

function makeEagerReady(overrides?: Partial<EagerSnapshot['context']>): EagerSnapshot {
	return {
		value: 'ready',
		context: {
			turnId: 1,
			eagerDraft: {
				agentResponse: 'Here are the rates.',
				userTranscript: 'what are the rates',
				controlBlock: 'test block',
			},
			eagerGeneratedAt: 100,
			sink: { chunks: [], done: true, forward: null },
			ttsPromise: null,
			triggerSynthesisStart: () => {},
			eagerStartedAt: 50,
			turnResumedSince: false,
			validatedTranscript: input.transcript,
			...overrides,
		},
	}
}

function makeEagerState(
	value: EagerSnapshot['value'],
	contextOverrides?: Partial<EagerSnapshot['context']>,
): EagerSnapshot {
	return {
		value,
		context: {
			turnId: 1,
			eagerDraft: null,
			eagerGeneratedAt: 0,
			sink: null,
			ttsPromise: null,
			triggerSynthesisStart: null,
			eagerStartedAt: 0,
			turnResumedSince: false,
			validatedTranscript: null,
			...contextOverrides,
		},
	}
}

describe('selectStrategy — discard / defer / backchannel', () => {
	it('isClosing → discard(closing)', () => {
		const result = selectStrategy(input, makeWorld({ isClosing: true }))
		assert.equal(result.kind, 'discard')
		if (result.kind === 'discard') assert.equal(result.reason, 'closing')
	})

	it('isClosing takes precedence over softPause', () => {
		const result = selectStrategy(input, makeWorld({ isClosing: true, inSoftPause: true }))
		assert.equal(result.kind, 'discard')
	})

	it('inSoftPause → defer(soft_paused)', () => {
		const result = selectStrategy(input, makeWorld({ inSoftPause: true }))
		assert.equal(result.kind, 'defer')
		if (result.kind === 'defer') assert.equal(result.reason, 'soft_paused')
	})

	it('backchannelResumedPending → discard(backchannel_handled)', () => {
		const result = selectStrategy(input, makeWorld({ backchannelResumedPending: true }))
		assert.equal(result.kind, 'discard')
		if (result.kind === 'discard') assert.equal(result.reason, 'backchannel_handled')
	})
})

describe('selectStrategy — interrupted fallback', () => {
	it('lastTurnWasInterrupted → fresh', () => {
		const result = selectStrategy(input, makeWorld({ lastTurnWasInterrupted: true }))
		assert.equal(result.kind, 'fresh')
	})

	it('interrupted takes precedence over ready eager', () => {
		const result = selectStrategy(input, makeWorld({ lastTurnWasInterrupted: true, eagerSnapshot: makeEagerReady() }))
		assert.equal(result.kind, 'fresh')
	})
})

describe('selectStrategy — eager ready (presynthesized)', () => {
	it('ready with matching transcript chooses presynthesized', () => {
		const result = selectStrategy(input, makeWorld({ eagerSnapshot: makeEagerReady({ validatedTranscript: null }) }))
		assert.equal(result.kind, 'presynthesized')
	})

	it('ready with turnResumedSince still promotes (transcript match is sufficient)', () => {
		const result = selectStrategy(input, makeWorld({ eagerSnapshot: makeEagerReady({ turnResumedSince: true }) }))
		assert.equal(result.kind, 'presynthesized')
	})

	it('ready but no sink → fresh', () => {
		const result = selectStrategy(input, makeWorld({ eagerSnapshot: makeEagerReady({ sink: null }) }))
		assert.equal(result.kind, 'fresh')
	})

	it('ready but no draft → fresh', () => {
		const result = selectStrategy(input, makeWorld({ eagerSnapshot: makeEagerReady({ eagerDraft: null }) }))
		assert.equal(result.kind, 'fresh')
	})

	it('ready but transcript diverged → fresh with racingPromotion', () => {
		const result = selectStrategy(
			{ ...input, transcript: 'can you check tomorrow at 2pm' },
			makeWorld({ eagerSnapshot: makeEagerReady() }),
		)
		assert.equal(result.kind, 'fresh')
		if (result.kind === 'fresh') assert.equal(result.racingPromotion, true)
	})
})

describe('selectStrategy — eager in-flight', () => {
	it('validating → fresh with racingPromotion', () => {
		const result = selectStrategy(input, makeWorld({ eagerSnapshot: makeEagerState('validating') }))
		assert.equal(result.kind, 'fresh')
		if (result.kind === 'fresh') assert.equal(result.racingPromotion, true)
	})
})

describe('selectStrategy — eager generating', () => {
	it('eagerGenerating → fresh with racingPromotion', () => {
		const result = selectStrategy(input, makeWorld({ eagerSnapshot: makeEagerState('eagerGenerating') }))
		assert.equal(result.kind, 'fresh')
		if (result.kind === 'fresh') assert.equal(result.racingPromotion, true)
	})
})

describe('selectStrategy — no eager / idle eager', () => {
	it('no eagerSnapshot → fresh (carries transcript)', () => {
		const result = selectStrategy(input, makeWorld())
		assert.equal(result.kind, 'fresh')
		if (result.kind === 'fresh') assert.equal(result.transcript, input.transcript)
	})

	it('eager idle → fresh', () => {
		const result = selectStrategy(input, makeWorld({ eagerSnapshot: makeEagerState('idle') }))
		assert.equal(result.kind, 'fresh')
	})
})

describe('selectStrategy — transcript propagation', () => {
	it('presynthesized carries transcript', () => {
		const result = selectStrategy(input, makeWorld({ eagerSnapshot: makeEagerReady() }))
		assert.equal(result.kind, 'presynthesized')
		if (result.kind === 'presynthesized') assert.equal(result.transcript, input.transcript)
	})
})
