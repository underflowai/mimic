/**
 * Evals as a compile artifact (improvements.md §6.2).
 *
 * Alongside the compiled prompt, every agent gets a test suite:
 * adversarial caller personas to run in simulation (replay / self-play)
 * and a scoring rubric an LLM judge applies to transcripts. Stored on
 * the agent row keyed by the same configHash as the compile, so eval
 * results always attach to the exact agent version they exercised.
 */

import OpenAI from 'openai'
import { z } from 'zod'

import type { AgentSpec } from './agent-spec.js'
import type { GoalCompilerInput } from './goal-compiler.js'

export const evalPersonaSchema = z.object({
	/** Short handle, e.g. "confused-elderly", "constant-interrupter". */
	id: z.string().min(1),
	name: z.string().min(1),
	/** Full behavioral brief for the LLM playing this caller. */
	persona: z.string().min(1),
	/** What this persona stresses: turn-taking, verification, tangents, hostility… */
	stresses: z.array(z.string()).default([]),
	difficulty: z.enum(['easy', 'medium', 'hard']),
})

export const evalRubricItemSchema = z.object({
	id: z.string().min(1),
	criterion: z.string().min(1),
	/** Relative importance 1-5. */
	weight: z.number().int().min(1).max(5),
})

export const agentEvalsSchema = z.object({
	personas: z.array(evalPersonaSchema).min(3),
	rubric: z.array(evalRubricItemSchema).min(3),
})

export type EvalPersona = z.infer<typeof evalPersonaSchema>
export type EvalRubricItem = z.infer<typeof evalRubricItemSchema>
export type AgentEvals = z.infer<typeof agentEvalsSchema>

const SYSTEM_PROMPT = `You design test suites for AI phone agents. Given an agent's goal, context, and contract, emit JSON with:

"personas": 4-6 adversarial caller personas the agent will be tested against in simulation. Each persona is a behavioral brief for an LLM that will play the caller on a synthetic phone call. Cover distinct stress axes — do not emit five variants of the same difficult caller:
- comprehension stress (confused/elderly caller, long mid-sentence pauses, asks for repetition)
- turn-taking stress (constant interrupter, rapid-fire speaker, talks over the agent)
- information stress (gives info out of order, changes answers, volunteers irrelevant detail)
- trust stress (suspicious "who is this?", refuses to confirm, threatens to hang up)
- edge cases from THIS specific goal (wrong number, wrong person, request outside the agent's authority)

Each persona brief must be written in second person ("You are…"), specify speech mannerisms and pacing, and state what the persona wants out of the call. Make them realistic phone callers, not cartoons.

"rubric": 4-8 weighted criteria an LLM judge applies to a finished transcript. Derive them from the agent's contract: every mustCollect field collected, every mustVerify value read back before any write action, prohibited behaviors absent, plus conversational quality (short turns, no repetition loops, graceful recovery from interruptions, appropriate closing). Each criterion must be independently checkable from a transcript. Weight 5 = contract-critical, 1 = polish.

Return JSON only: { "personas": [{ "id", "name", "persona", "stresses": [], "difficulty" }], "rubric": [{ "id", "criterion", "weight" }] }`

function buildUserPrompt(input: GoalCompilerInput, spec: AgentSpec): string {
	const parts = [
		'Goal:',
		input.goal,
		'',
		'Context:',
		typeof input.context === 'string'
			? input.context || 'None.'
			: Object.entries(input.context)
					.map(([k, v]) => `${k}: ${v}`)
					.join('\n') || 'None.',
		'',
		'Agent contract:',
		`mustCollect: ${spec.mustCollect.join(', ') || 'none'}`,
		`mustVerify: ${spec.mustVerify.join(', ') || 'none'}`,
		`writeActions: ${spec.writeActions.map((a) => a.name).join(', ') || 'none'}`,
		`successCriteria: ${spec.successCriteria.join(' | ') || 'none'}`,
		`prohibited: ${spec.prohibited.join(' | ') || 'none'}`,
	]
	if (input.data && Object.keys(input.data).length > 0) {
		parts.push('', `Structured data fields: ${Object.keys(input.data).join(', ')}`)
	}
	if (Object.keys(input.results).length > 0) {
		parts.push('', `Result fields to extract: ${Object.keys(input.results).join(', ')}`)
	}
	return parts.join('\n')
}

export async function generateEvals(input: GoalCompilerInput, spec: AgentSpec): Promise<AgentEvals> {
	const openai = new OpenAI()
	const result = await openai.chat.completions.create({
		model: 'gpt-5.4',
		temperature: 0.3,
		max_completion_tokens: 6000,
		response_format: { type: 'json_object' },
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: buildUserPrompt(input, spec) },
		],
	})

	const raw = result.choices[0]?.message?.content?.trim() ?? ''
	return agentEvalsSchema.parse(JSON.parse(raw))
}
