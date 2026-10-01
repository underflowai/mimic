/**
 * Typed AgentSpec — a machine-checkable contract sidecar emitted by the
 * goal compiler alongside the prose prompt (improvements.md §6.3).
 *
 * The prose `compiledPrompt` stays the behavioral source for the
 * speaking model; the spec is the deterministic contract the rest of
 * the system checks against:
 *   - tool watcher gets `mustVerify` (read-back before WRITE tools)
 *   - control block reminds the agent of the open contract every turn
 *   - extraction judges `successCriteria`
 *   - replay/eval judges score against the whole spec
 */

import { z } from 'zod'

import type { GoalCompilerInput, GoalToolDefinition } from './goal-compiler.js'

export interface AgentSpecWriteAction {
	name: string
	description: string
	/** Explicit caller confirmation required before this action fires. */
	requiresConfirmation: boolean
}

export interface AgentSpec {
	version: 1
	/** Fields the agent must collect or confirm before closing the call. */
	mustCollect: string[]
	/** Values that must be read back and confirmed by the caller before any WRITE tool uses them. */
	mustVerify: string[]
	/** WRITE tools with their confirmation requirements. Built from the tool definitions, not the LLM. */
	writeActions: AgentSpecWriteAction[]
	/** Machine-checkable descriptions of what makes this call a success. */
	successCriteria: string[]
	/** Things the agent must never do or say on this call. */
	prohibited: string[]
}

/** The spec fields the compiler LLM emits (the rest is deterministic). */
export const agentSpecLlmFieldsSchema = z.object({
	mustCollect: z.array(z.string()).default([]),
	mustVerify: z.array(z.string()).default([]),
	successCriteria: z.array(z.string()).default([]),
	prohibited: z.array(z.string()).default([]),
})

export type AgentSpecLlmFields = z.infer<typeof agentSpecLlmFieldsSchema>

export function buildAgentSpec(llmFields: AgentSpecLlmFields, tools: GoalToolDefinition[]): AgentSpec {
	return {
		version: 1,
		mustCollect: llmFields.mustCollect,
		mustVerify: llmFields.mustVerify,
		writeActions: tools
			.filter((t) => t.kind === 'write')
			.map((t) => ({
				name: t.name,
				description: t.description,
				requiresConfirmation: t.requiresConfirmation !== false,
			})),
		successCriteria: llmFields.successCriteria,
		prohibited: llmFields.prohibited,
	}
}

/**
 * Compile-time lint: verify the compiled prompt satisfies its own spec
 * before it gets cached. Returns human-readable warnings (never blocks
 * the compile — a warning-laden agent still works, it's just less
 * verifiable).
 */
export function lintAgentSpec(
	spec: AgentSpec,
	input: Pick<GoalCompilerInput, 'data' | 'results' | 'tools'>,
	compiledPrompt: string,
): string[] {
	const warnings: string[] = []
	const knownFields = new Set([...Object.keys(input.data ?? {}), ...Object.keys(input.results ?? {})])
	const knownTools = new Set(input.tools.map((t) => t.name))
	const promptLower = compiledPrompt.toLowerCase()

	for (const field of spec.mustCollect) {
		if (knownFields.size > 0 && !knownFields.has(field)) {
			warnings.push(`mustCollect field "${field}" is not a declared data or results field`)
		}
		if (!promptLower.includes(field.toLowerCase())) {
			warnings.push(`compiled prompt never mentions mustCollect field "${field}"`)
		}
	}

	for (const field of spec.mustVerify) {
		if (!promptLower.includes(field.toLowerCase())) {
			warnings.push(`compiled prompt never mentions mustVerify field "${field}"`)
		}
	}

	for (const action of spec.writeActions) {
		if (!knownTools.has(action.name)) {
			warnings.push(`writeAction "${action.name}" references an unknown tool`)
		}
	}

	if (spec.successCriteria.length === 0) {
		warnings.push('spec has no successCriteria — extraction falls back to unguided LLM judgment')
	}

	const hasWriteTools = input.tools.some((t) => t.kind === 'write')
	if (hasWriteTools && spec.mustVerify.length === 0) {
		warnings.push('agent has WRITE tools but the spec lists no mustVerify values')
	}

	return warnings
}

/** Renders the spec as a compact contract block for per-turn steering. */
export function buildAgentContractBlock(spec: AgentSpec | null | undefined): string | null {
	if (!spec) return null
	const lines: string[] = []
	if (spec.mustCollect.length > 0) lines.push(`Before closing, you must have collected/confirmed: ${spec.mustCollect.join(', ')}.`)
	if (spec.mustVerify.length > 0) lines.push(`Read back and get explicit caller confirmation before acting on: ${spec.mustVerify.join(', ')}.`)
	if (spec.writeActions.some((a) => a.requiresConfirmation)) {
		lines.push(
			`Actions requiring explicit caller confirmation first: ${spec.writeActions.filter((a) => a.requiresConfirmation).map((a) => a.name).join(', ')}.`,
		)
	}
	if (spec.prohibited.length > 0) lines.push(`Never: ${spec.prohibited.join('; ')}.`)
	if (lines.length === 0) return null
	return ['<agent_contract>', ...lines, '</agent_contract>'].join('\n')
}
