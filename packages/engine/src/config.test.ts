import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { config, getNumberEnv } from './config.js'

const key = 'MIMIC_TEST_NUMBER_ENV'

afterEach(() => {
	delete process.env[key]
})

describe('getNumberEnv', () => {
	it('returns the default when the variable is unset or blank', () => {
		assert.equal(getNumberEnv(key, 42), 42)
		process.env[key] = '   '
		assert.equal(getNumberEnv(key, 42), 42)
	})

	it('parses a valid number within bounds', () => {
		process.env[key] = '0.25'
		assert.equal(getNumberEnv(key, 0.5, { min: 0, max: 1 }), 0.25)
	})

	it('rejects values that are not numbers', () => {
		process.env[key] = 'fast'
		assert.throws(() => getNumberEnv(key, 1), /MIMIC_TEST_NUMBER_ENV must be a number \(received "fast"\)/)
	})

	it('rejects out-of-range values with the bounds in the message', () => {
		process.env[key] = '1.5'
		assert.throws(() => getNumberEnv(key, 0.5, { min: 0, max: 1 }), /must be a number >= 0 <= 1/)
	})

	it('rejects non-integers when an integer is required', () => {
		process.env[key] = '350.5'
		assert.throws(() => getNumberEnv(key, 350, { integer: true }), /must be an integer/)
		process.env[key] = '350'
		assert.equal(getNumberEnv(key, 0, { integer: true }), 350)
	})
})

describe('config.mimic tuning knobs', () => {
	it('uses balanced Flux defaults that favor complete caller turns', () => {
		const keys = [
			'MIMIC_FLUX_MODEL',
			'MIMIC_FLUX_EOT_THRESHOLD',
			'MIMIC_FLUX_EAGER_EOT_THRESHOLD',
			'MIMIC_FLUX_EOT_TIMEOUT_MS',
		] as const
		const original = new Map(keys.map((name) => [name, process.env[name]]))
		for (const name of keys) delete process.env[name]
		try {
			assert.equal(config.mimic.flux.model, 'flux-general-en')
			assert.equal(config.mimic.flux.eotThreshold, 0.7)
			assert.equal(config.mimic.flux.eagerEotThreshold, 0.3)
			assert.equal(config.mimic.flux.eotTimeoutMs, 3000)
			assert.ok(config.mimic.flux.reconnect.initialBackoffMs < config.mimic.flux.reconnect.maxBackoffMs)
		} finally {
			for (const name of keys) {
				const value = original.get(name)
				if (value === undefined) delete process.env[name]
				else process.env[name] = value
			}
		}
	})

	it('reads turn-taking overrides from the environment', () => {
		const original = process.env.MIMIC_YIELD_WINDOW_MS
		process.env.MIMIC_YIELD_WINDOW_MS = '120'
		try {
			assert.equal(config.mimic.turnTaking.yieldWindowMs, 120)
		} finally {
			if (original === undefined) delete process.env.MIMIC_YIELD_WINDOW_MS
			else process.env.MIMIC_YIELD_WINDOW_MS = original
		}
	})
})
