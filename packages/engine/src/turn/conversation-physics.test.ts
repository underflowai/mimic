import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { createConversationPhysics } from './conversation-physics.js'

function build() {
	const configureTranscriber = mock.fn()
	const onActivate = mock.fn()
	const physics = createConversationPhysics({ configureTranscriber, onActivate })
	return { physics, configureTranscriber, onActivate }
}

describe('conversation physics v1', () => {
	it('starts with neutral tunables', () => {
		const { physics } = build()
		const tunables = physics.getTunables()
		assert.equal(tunables.substantiveSpeechExtraMs, 0)
		assert.equal(tunables.silenceWatchdogExtraMs, 0)
		assert.equal(tunables.earlyCommitDisabled, false)
		assert.equal(tunables.controlBlockLine, null)
		assert.equal(physics.isSlowCaller(), false)
	})

	it('latches after two TurnResumed events', () => {
		const { physics, configureTranscriber } = build()
		physics.noteTurnResumed()
		assert.equal(physics.isSlowCaller(), false)
		physics.noteTurnResumed()
		assert.equal(physics.isSlowCaller(), true)
		assert.equal(configureTranscriber.mock.calls.length, 1)
		const opts = configureTranscriber.mock.calls[0]?.arguments[0] as { eotThreshold: number; eotTimeoutMs: number }
		assert.ok(opts.eotThreshold > 0.5)
		assert.ok(opts.eotTimeoutMs > 2000)
	})

	it('latches after a single soft-pause escalation', () => {
		const { physics } = build()
		physics.noteInterrupt({ sentMs: 5000, escalatedFromSoftPause: true })
		assert.equal(physics.isSlowCaller(), true)
	})

	it('latches after two early barges but not one', () => {
		const { physics } = build()
		physics.noteInterrupt({ sentMs: 400, escalatedFromSoftPause: false })
		assert.equal(physics.isSlowCaller(), false)
		physics.noteInterrupt({ sentMs: 900, escalatedFromSoftPause: false })
		assert.equal(physics.isSlowCaller(), true)
	})

	it('ignores late barges — an interrupt deep into a long answer is normal', () => {
		const { physics } = build()
		physics.noteInterrupt({ sentMs: 8000, escalatedFromSoftPause: false })
		physics.noteInterrupt({ sentMs: 9000, escalatedFromSoftPause: false })
		assert.equal(physics.isSlowCaller(), false)
	})

	it('slow-caller tunables widen every knob and disable early commit', () => {
		const { physics, onActivate } = build()
		physics.noteTurnResumed()
		physics.noteTurnResumed()
		const tunables = physics.getTunables()
		assert.ok(tunables.substantiveSpeechExtraMs > 0)
		assert.ok(tunables.silenceWatchdogExtraMs > 0)
		assert.equal(tunables.earlyCommitDisabled, true)
		assert.ok(tunables.controlBlockLine && tunables.controlBlockLine.length > 0)
		assert.equal(onActivate.mock.calls.length, 1)
	})

	it('latches exactly once', () => {
		const { physics, configureTranscriber } = build()
		physics.noteTurnResumed()
		physics.noteTurnResumed()
		physics.noteTurnResumed()
		physics.noteInterrupt({ sentMs: 100, escalatedFromSoftPause: true })
		assert.equal(configureTranscriber.mock.calls.length, 1)
	})
})
