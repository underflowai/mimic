import {
	appendEndCallGuidance,
	appendInterruptContext,
	appendToolLifecycleGuidance,
	appendTranscriptQualityGuidance,
} from './intelligence/control-block-utils.js'
import type { InterruptContext } from './intelligence/types.js'

export interface TurnControlBlockContext {
	transcript: string
	userFirstName: string
	recipient?: {
		firstName?: string
		lastName?: string
		email?: string
	}
	userTimezone?: string
	interruptContext: InterruptContext | null
	hasActiveTools?: boolean
	pendingTools?: string[]
	toolResults?: Array<{ topic: string; result: string }>
	executingTools?: string[]
	toolDefinitions?: Array<{ name: string; description: string }>
	silenceFollowUp?: boolean
	silenceClosing?: boolean
	silenceFollowUpCount?: number | null
}

export interface TurnControlBlockBuildOptions {
	silenceFollowUp?: boolean
	silenceClosing?: boolean
	silenceFollowUpCount?: number
	/** A single tool result to highlight first in the prompt. */
	toolResult?: { topic: string; result: string } | null
	toolResults?: Array<{ topic: string; result: string }>
	hasActiveTools?: boolean
	pendingTools?: string[]
	executingTools?: string[]
	toolDefinitions?: Array<{ name: string; description: string }>
}

export interface TurnControlBlockBuilderDeps {
	getUserFirstName: () => string
	getRecipient: () => TurnControlBlockContext['recipient']
	getUserTimezone: () => string | undefined
	buildTurnControlBlock: (ctx: TurnControlBlockContext) => string
	/** Compiler-generated text quality block. Replaces generic transcript guidance when set. */
	textQualityBlock?: string
	/** Tell the director it may hang up with the `[end-call]` tag. */
	endCallEnabled?: boolean
}

export interface TurnControlBlockOutcome {
	interruptContext: InterruptContext | null
}

const defaultSpokenCadenceGuidance = [
	'You are mid-conversation on a live phone call. React to what they said, then do the next useful thing.',
	'Keep it to one or two sentences. Contractions, fragments, spoken rhythm.',
	'On about one turn in three, open with a filler and a pause — "umm <break time="50ms"/>" or "uhh <break time="25ms"/>".',
	'If they are venting, skeptical, or mid-story: ask or acknowledge, do not pitch.',
	'If they ask for a pause, reply with one short acknowledgment only.',
].join('\n')

/**
 * Shared mimic-level signals appended after every strategy-specific
 * control block (transcript quality, active tool stall, end-call tag,
 * interrupt context).
 */
function appendSharedSignals(parts: string[], ctx: TurnControlBlockContext, deps: TurnControlBlockBuilderDeps) {
	if (deps.textQualityBlock) {
		parts.push(deps.textQualityBlock)
	} else {
		// Persona-mode agents have no compiled turnControlBlock; give them the same cadence steer.
		parts.push(defaultSpokenCadenceGuidance)
		appendTranscriptQualityGuidance(parts)
	}
	appendToolLifecycleGuidance(parts, {
		toolDefinitions: ctx.toolDefinitions,
		executingTools: ctx.executingTools,
		pendingTools: ctx.pendingTools,
	})
	if (deps.endCallEnabled) appendEndCallGuidance(parts)
	appendInterruptContext(parts, ctx.interruptContext)
}

function buildSilenceInstruction(opts?: TurnControlBlockBuildOptions) {
	if (!opts?.silenceFollowUp) return null
	if (opts.silenceClosing) {
		return 'The caller has stayed quiet after a couple of gentle check-ins. Say a brief goodbye. One sentence, no question.'
	}
	return 'The caller has been quiet for a few seconds. If they are waiting on you, continue with the next useful thing. Otherwise gently check in or give them a little space. One sentence.'
}

export function createTurnControlBlockBuilder(deps: TurnControlBlockBuilderDeps) {
	function build(transcript: string, outcome: TurnControlBlockOutcome, opts?: TurnControlBlockBuildOptions) {
		const baseToolResults = opts?.toolResults ?? []
		const baseExecutingTools = opts?.executingTools ?? []
		const basePendingTools = opts?.pendingTools ?? []
		const toolResults = opts?.toolResult ? [opts.toolResult, ...baseToolResults] : baseToolResults

		const ctx: TurnControlBlockContext = {
			transcript,
			userFirstName: deps.getUserFirstName(),
			recipient: deps.getRecipient(),
			userTimezone: deps.getUserTimezone(),
			interruptContext: outcome.interruptContext,
			hasActiveTools: opts?.hasActiveTools,
			pendingTools: basePendingTools.length > 0 ? basePendingTools : undefined,
			toolResults: toolResults.length > 0 ? toolResults : undefined,
			executingTools: baseExecutingTools.length > 0 ? baseExecutingTools : undefined,
			toolDefinitions: opts?.toolDefinitions,
			silenceFollowUp: opts?.silenceFollowUp === true,
			silenceClosing: opts?.silenceClosing === true,
			silenceFollowUpCount: typeof opts?.silenceFollowUpCount === 'number' ? opts.silenceFollowUpCount : null,
		}

		const strategyBlock = deps.buildTurnControlBlock(ctx)

		const signalParts: string[] = []
		appendSharedSignals(signalParts, ctx, deps)

		const silenceInstruction = buildSilenceInstruction(opts)
		if (silenceInstruction) signalParts.push(silenceInstruction)

		let block = strategyBlock
		if (signalParts.length > 0) {
			block = block ? `${block}\n${signalParts.join('\n')}` : signalParts.join('\n')
		}

		return block
	}

	return { build }
}
