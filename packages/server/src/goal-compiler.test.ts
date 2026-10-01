import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import type OpenAI from 'openai'

import { arloPersona } from '@mimic/engine'
import {
	buildOrchestratorConfigFromAgent,
	compileGoal,
	type AgentConfig,
	type GoalCompilerInput,
} from './goal-compiler.js'

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		goal: 'Collect a preferred appointment time.',
		voice: 'male',
		context: {},
		tools: [],
		results: {},
		aiDisclosure: true,
		agentName: 'Casey',
		systemPrompt: 'You are [AGENT_NAME].',
		turnControlBlock: '[AGENT_NAME], answer the caller directly.',
		...overrides,
	}
}

describe('buildOrchestratorConfigFromAgent', () => {
	it('keeps the configured identity across speech, turn guidance, and background workers', () => {
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(agent())
		assert.equal(orchestratorConfig.persona?.firstName, 'Casey')
		assert.equal(orchestratorConfig.persona?.ttsVoiceId, arloPersona.ttsVoiceId)
		assert.equal(orchestratorConfig.systemPrompt, 'You are Casey.')
		assert.equal(orchestratorConfig.textQualityBlock, 'Casey, answer the caller directly.')
		assert.equal(arloPersona.firstName, 'Arlo', 'shared voice defaults must not be mutated')
	})

	it('passes the caller timezone to subsequent turns and research, not just the opening', () => {
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(agent(), {
			userTimezone: 'America/New_York',
			firstName: 'Morgan',
			email: 'morgan@example.com',
		})
		assert.equal(orchestratorConfig.userTimezone, 'America/New_York')
		assert.equal(orchestratorConfig.userTimezoneInferred, false)
		assert.equal(orchestratorConfig.recipient?.firstName, 'Morgan')
		const opening = orchestratorConfig.buildOpeningBlock()
		assert.match(opening, /callerEmail: morgan@example.com/)
		assert.doesNotMatch(opening, /guessed from the caller/)
	})

	it('labels an area-code timezone guess as unconfirmed on every date line', () => {
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(agent(), {
			userTimezone: 'America/Chicago',
			userTimezoneInferred: 'true',
		})
		assert.equal(orchestratorConfig.userTimezoneInferred, true)
		assert.match(
			orchestratorConfig.buildOpeningBlock(),
			/now: .* C[DS]T \(timezone guessed from the caller’s area code — unconfirmed\)/,
		)
		const turn = orchestratorConfig.buildTurnControlBlock({
			transcript: 'hello',
			userFirstName: 'Casey',
			userTimezone: 'America/Chicago',
			userTimezoneInferred: true,
			interruptContext: null,
		})
		assert.match(turn, /guessed from the caller’s area code — unconfirmed/)
	})

	it('ignores a stray inferred flag when no timezone is set', () => {
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(agent(), { userTimezoneInferred: 'true' })
		assert.equal(orchestratorConfig.userTimezoneInferred, false)
		assert.match(orchestratorConfig.buildOpeningBlock(), /caller timezone unavailable; UTC reference/)
	})

	it('enables the existing hangup protocol for API calls', () => {
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(agent())
		assert.equal(orchestratorConfig.endCallEnabled, true)
	})

	it('uses the voice fallback only when the stored agent name is empty', () => {
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(agent({ agentName: '  ' }))
		assert.equal(orchestratorConfig.persona?.firstName, 'Arlo')
	})

	it('injects the per-call data values into the system prompt, so the shared compiled prompt can refer to them by name', () => {
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(agent(), undefined, {
			appointmentTime: 'Tuesday 3 PM',
			provider: 'Dr. Patel',
			preference: { value: null, validOptions: ['morning', 'afternoon'] },
			visits: [{ date: 'May 2', reason: 'cleaning' }],
		})
		const prompt = orchestratorConfig.systemPrompt
		assert.match(prompt, /^You are Casey\./)
		assert.match(prompt, /<data>[\s\S]*appointmentTime: Tuesday 3 PM[\s\S]*<\/data>/)
		assert.match(prompt, /provider: Dr\. Patel/)
		assert.match(prompt, /preference: MISSING \(valid options: morning, afternoon\)/)
		assert.match(prompt, /1\. date: May 2/)
		assert.doesNotMatch(
			orchestratorConfig.buildOpeningBlock(),
			/<data>/,
			'values are not repeated in the opening block',
		)
	})

	it('offers supplied data and context to the write gate as legitimate argument sources', () => {
		const withBoth = buildOrchestratorConfigFromAgent(
			agent({ context: { office: 'Bright Smiles, (512) 555-0100' } }),
			undefined,
			{ patientPhone: '(415) 555-1234' },
		)
		assert.deepEqual(withBoth.orchestratorConfig.toolKnownValues, [
			'<data>\npatientPhone: (415) 555-1234\n</data>',
			'office: Bright Smiles, (512) 555-0100',
		])
		assert.deepEqual(buildOrchestratorConfigFromAgent(agent()).orchestratorConfig.toolKnownValues, [])
	})

	it('leaves the prompt alone when a call has no data', () => {
		assert.equal(
			buildOrchestratorConfigFromAgent(agent(), undefined, null).orchestratorConfig.systemPrompt,
			'You are Casey.',
		)
		assert.equal(
			buildOrchestratorConfigFromAgent(agent(), undefined, {}).orchestratorConfig.systemPrompt,
			'You are Casey.',
		)
	})

	it('falls back to data stored on the agent config for direct (non-API) callers', () => {
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(agent({ data: { office: 'Bright Smiles' } }))
		assert.match(orchestratorConfig.systemPrompt, /office: Bright Smiles/)
	})
})

describe('compileGoal', () => {
	it('preserves names and field metadata while supplying runtime capabilities', async () => {
		const compiled = {
			compiledPrompt: 'You are Al. The caller is Alex in Albany. Contact Al at Al@example.com.',
			speechTags: 'Speak concisely.',
			turnControlBlock: 'Answer directly.',
			agentName: 'Al',
		}
		const create = mock.fn(async (_input: unknown) => ({
			choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(compiled) } }],
		}))
		const client = { chat: { completions: { create } } } as unknown as OpenAI
		const input: GoalCompilerInput = {
			goal: 'Collect preferences.',
			voice: 'male',
			context: {},
			tools: [],
			results: { booked: 'Whether a booking was confirmed.' },
			data: {
				appointmentTime: 'Tuesday 3 PM',
				notes: null,
				preference: {
					value: 'morning',
					validOptions: ['morning', 'afternoon'],
					required: false,
					optional: true,
					nullable: true,
					condition: 'Collect only when rescheduling',
					source: 'caller',
				},
				visits: [{ date: 'May 2', reason: 'cleaning' }],
			},
		}
		const result = await compileGoal(input, client)
		assert.match(result.systemPrompt, /The caller is Alex in Albany\. Contact Al at Al@example\.com\./)
		assert.equal(result.systemPrompt.includes('[AGENT_NAME]'), false)
		assert.equal(result.agentName, 'Al')
		const request = create.mock.calls[0]!.arguments[0] as { messages: Array<{ role: string; content: string }> }
		const compilerInstructions = request.messages.find((message) => message.role === 'system')!.content
		assert.match(compilerInstructions, /Translate implementation-facing concepts into ordinary caller language/)
		assert.match(compilerInstructions, /Runtime cadence guidance controls fillers and pause frequency/)
		assert.doesNotMatch(compilerInstructions, /developer's goal/i)
		assert.ok(
			compilerInstructions.trim().split(/\s+/).length < 1_200,
			'compiler instructions should stay compact enough to leave room for model judgment',
		)
		const userInput = request.messages.find((message) => message.role === 'user')!.content
		assert.match(userInput, /webSearch \(read\)/)
		assert.match(userInput, /only break and spell SSML tags pass through/)
		assert.match(userInput, /"required":false,"optional":true,"nullable":true/)
		assert.match(userInput, /Collect only when rescheduling/)
		assert.match(userInput, /"source":"caller"/)
		assert.match(userInput, /Requested post-call result fields \(desired extraction, not evidence/)

		// The compiler sees which fields exist and which are supplied, never the
		// values: one compiled prompt serves every call with this data shape.
		assert.match(userInput, /appointmentTime: provided \(text\)/)
		assert.match(userInput, /notes: missing/)
		assert.match(userInput, /preference: provided \(valid options: morning, afternoon; metadata: /)
		assert.match(
			userInput,
			/visits: list of items, each with:\n {2}date: provided \(text\)\n {2}reason: provided \(text\)/,
		)
		assert.doesNotMatch(userInput, /Tuesday 3 PM|May 2|cleaning/)
		assert.match(userInput, /supplied per call at runtime in a <data> block/)
	})
})
