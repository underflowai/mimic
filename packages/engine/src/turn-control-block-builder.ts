import {
	appendEndCallGuidance,
	appendInterruptContext,
	appendToolLifecycleGuidance,
	appendTranscriptQualityGuidance,
	loadControlBlockPrompts,
	type ControlBlockPrompts,
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

/**
 * Shared mimic-level signals appended after every strategy-specific
 * control block (transcript quality, active tool stall, end-call tag,
 * interrupt context). Wording lives in `prompts/control-block/`.
 */
function appendSharedSignals(
	parts: string[],
	ctx: TurnControlBlockContext,
	deps: TurnControlBlockBuilderDeps,
	prompts: ControlBlockPrompts,
) {
	if (deps.textQualityBlock) {
		parts.push(deps.textQualityBlock)
	} else {
		// Persona-mode agents have no compiled turnControlBlock; give them the same cadence steer.
		parts.push(prompts.spokenCadence)
		appendTranscriptQualityGuidance(parts, prompts)
	}
	appendToolLifecycleGuidance(
		parts,
		{
			toolDefinitions: ctx.toolDefinitions,
			executingTools: ctx.executingTools,
			pendingTools: ctx.pendingTools,
		},
		prompts,
	)
	if (deps.endCallEnabled) appendEndCallGuidance(parts, prompts)
	appendInterruptContext(parts, ctx.interruptContext, prompts)
}

function buildSilenceInstruction(prompts: ControlBlockPrompts, opts?: TurnControlBlockBuildOptions) {
	if (!opts?.silenceFollowUp) return null
	return opts.silenceClosing ? prompts.silenceClosing : prompts.silenceFollowUp
}

/** Loads the shared control-block fragments once, then builds blocks synchronously per turn. */
export async function createTurnControlBlockBuilder(deps: TurnControlBlockBuilderDeps) {
	const prompts = await loadControlBlockPrompts()

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
		appendSharedSignals(signalParts, ctx, deps, prompts)

		const silenceInstruction = buildSilenceInstruction(prompts, opts)
		if (silenceInstruction) signalParts.push(silenceInstruction)
		// Apply these to both compiler-generated and persona blocks, after situational nudges.
		signalParts.push(prompts.turnPriorities)

		let block = strategyBlock
		if (signalParts.length > 0) {
			block = block ? `${block}\n${signalParts.join('\n')}` : signalParts.join('\n')
		}

		return block
	}

	return { build }
}

export type TurnControlBlockBuilder = Awaited<ReturnType<typeof createTurnControlBlockBuilder>>
