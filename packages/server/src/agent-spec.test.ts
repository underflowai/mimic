import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildAgentContractBlock, buildAgentSpec, lintAgentSpec, type AgentSpec } from './agent-spec.js'
import type { GoalToolDefinition } from './goal-compiler.js'

const tools: GoalToolDefinition[] = [
	{ name: 'checkCalendar', description: 'Check open slots', kind: 'read', parameters: {} },
	{ name: 'bookAppointment', description: 'Book a slot', kind: 'write', parameters: {} },
	{ name: 'cancelAppointment', description: 'Cancel a slot', kind: 'write', parameters: {}, requiresConfirmation: false },
]

describe('buildAgentSpec', () => {
	it('derives writeActions from tool definitions, defaulting confirmation to required', () => {
		const spec = buildAgentSpec(
			{ mustCollect: ['date'], mustVerify: ['date'], successCriteria: ['booked'], prohibited: [] },
			tools,
		)
		assert.deepEqual(spec.writeActions, [
			{ name: 'bookAppointment', description: 'Book a slot', requiresConfirmation: true },
			{ name: 'cancelAppointment', description: 'Cancel a slot', requiresConfirmation: false },
		])
		assert.equal(spec.version, 1)
	})
})

describe('lintAgentSpec', () => {
	const base: AgentSpec = {
		version: 1,
		mustCollect: ['appointmentDate'],
		mustVerify: ['appointmentDate'],
		writeActions: [{ name: 'bookAppointment', description: 'Book', requiresConfirmation: true }],
		successCriteria: ['Caller explicitly confirmed the appointmentDate'],
		prohibited: [],
	}
	const input = {
		data: { appointmentDate: 'May 16' },
		results: {},
		tools,
	}

	it('passes a consistent spec against a prompt that mentions its fields', () => {
		const warnings = lintAgentSpec(base, input, 'Confirm the appointmentDate with the caller before booking.')
		assert.deepEqual(warnings, [])
	})

	it('flags fields the compiled prompt never mentions', () => {
		const warnings = lintAgentSpec(base, input, 'Say hello and hang up.')
		assert.ok(warnings.some((w) => w.includes('mustCollect field "appointmentDate"')))
		assert.ok(warnings.some((w) => w.includes('mustVerify field "appointmentDate"')))
	})

	it('flags undeclared mustCollect fields and unknown write tools', () => {
		const spec: AgentSpec = {
			...base,
			mustCollect: ['petName'],
			writeActions: [{ name: 'launchMissiles', description: '', requiresConfirmation: true }],
		}
		const warnings = lintAgentSpec(spec, input, 'Collect the petName.')
		assert.ok(warnings.some((w) => w.includes('"petName" is not a declared')))
		assert.ok(warnings.some((w) => w.includes('launchMissiles')))
	})

	it('flags write tools with an empty mustVerify list', () => {
		const spec: AgentSpec = { ...base, mustVerify: [] }
		const warnings = lintAgentSpec(spec, input, 'Confirm the appointmentDate before booking.')
		assert.ok(warnings.some((w) => w.includes('no mustVerify')))
	})

	it('warns when successCriteria is empty', () => {
		const spec: AgentSpec = { ...base, successCriteria: [] }
		const warnings = lintAgentSpec(spec, input, 'Confirm the appointmentDate before booking.')
		assert.ok(warnings.some((w) => w.includes('successCriteria')))
	})
})

describe('buildAgentContractBlock', () => {
	it('renders only populated sections', () => {
		const block = buildAgentContractBlock({
			version: 1,
			mustCollect: ['date', 'time'],
			mustVerify: ['date'],
			writeActions: [{ name: 'bookAppointment', description: '', requiresConfirmation: true }],
			successCriteria: ['booked'],
			prohibited: ['Never quote a price'],
		})
		assert.ok(block!.startsWith('<agent_contract>'))
		assert.ok(block!.includes('date, time'))
		assert.ok(block!.includes('bookAppointment'))
		assert.ok(block!.includes('Never: Never quote a price'))
	})

	it('returns null for an empty or missing spec', () => {
		assert.equal(buildAgentContractBlock(null), null)
		assert.equal(
			buildAgentContractBlock({
				version: 1,
				mustCollect: [],
				mustVerify: [],
				writeActions: [],
				successCriteria: ['ok'],
				prohibited: [],
			}),
			null,
		)
	})
})
