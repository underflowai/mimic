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
				preference: {
					value: null,
					validOptions: ['morning', 'afternoon'],
					required: false,
					optional: true,
					nullable: true,
					condition: 'Collect only when rescheduling',
					source: 'caller',
				},
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
	})
})
