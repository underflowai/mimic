/**
 * Control Block Utilities
 *
 * Shared utilities used by voice strategy consumers (intake, form collection)
 * when constructing per-turn control block strings. Mimic itself does not
 * build control blocks — consumers provide them via callbacks.
 */

import type { InterruptContext } from './types.js'

export type { InterruptContext } from './types.js'

export function formatUserDateTime(timezone?: string) {
	const tz = timezone ?? 'America/Los_Angeles'
	const now = new Date()
	const date = now.toLocaleDateString('en-US', {
		timeZone: tz,
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
	})
	const time = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
	const tzAbbr =
		new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
			.formatToParts(now)
			.find((p) => p.type === 'timeZoneName')?.value ?? tz
	return `${date}, ${time} ${tzAbbr}`
}

function normalizeWord(word: string) {
	return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

function deriveUnsaidPortion(fullDraft: string, heardPortion: string) {
	if (!heardPortion.trim()) return ''
	if (fullDraft.startsWith(heardPortion)) {
		return fullDraft.slice(heardPortion.length).trim()
	}

	const fullWords = fullDraft.trim().split(/\s+/).filter(Boolean)
	const heardWords = heardPortion.trim().split(/\s+/).filter(Boolean)
	let sharedPrefixWords = 0
	while (sharedPrefixWords < fullWords.length && sharedPrefixWords < heardWords.length) {
		if (normalizeWord(fullWords[sharedPrefixWords]) !== normalizeWord(heardWords[sharedPrefixWords])) break
		sharedPrefixWords++
	}

	if (sharedPrefixWords === 0) return ''
	return fullWords.slice(sharedPrefixWords).join(' ').trim()
}

export function appendTranscriptQualityGuidance(parts: string[]) {
	parts.push(
		'Voice transcription can garble names, companies, technical terms, and numbers. Before asking the caller to repeat, check if the conversation context makes the intended meaning obvious. If so, use the likely correct term and move forward — you can confirm casually. Only ask to repeat when the meaning is truly unclear. Never accept a word at face value if it makes no sense in context.',
	)
}

// ── Tool lifecycle guidance ──────────────────────────────────────────

export interface ToolLifecycleContext {
	toolDefinitions?: Array<{ name: string; description: string }>
	executingTools?: string[]
	pendingTools?: string[]
}

export function appendToolLifecycleGuidance(parts: string[], ctx: ToolLifecycleContext) {
	const executing = ctx.executingTools ?? []
	const pending = ctx.pendingTools ?? []

	if (executing.length > 0) {
		for (const note of executing) {
			parts.push(`Tool note: ${note}`)
		}
		parts.push(
			'The tool is running. Keep the caller oriented with one short natural sentence if needed. Do not announce the outcome until the result arrives.',
		)
	}

	if (pending.length > 0) {
		for (const nudge of pending) parts.push(`Tool note: ${nudge}`)
	}

	if (executing.length > 0 || pending.length > 0) return

	const defs = ctx.toolDefinitions ?? []
	if (defs.length === 0) return

	const toolList = defs.map((t) => `${t.name} (${t.description})`).join(', ')
	parts.push(
		`Tools available: ${toolList}. When a caller asks for something a tool can handle, speak one short filler phrase ("Let me take a look.", "I'm checking that now.", "One moment.") and keep the conversation moving naturally. The tool runs in the background — its result will arrive shortly. Do not say "sure" or "good question"; do NOT confirm any outcome before the result arrives. For scheduling or calendar requests, never say a date/time works, is available, booked, scheduled, or confirmed unless a tool result explicitly says so.`,
	)
}

// ── Interrupt context ───────────────────────────────────────────────

export function appendInterruptContext(parts: string[], ctx: InterruptContext | null) {
	if (!ctx?.heardPortion) return
	const unsaidPortion = deriveUnsaidPortion(ctx.fullDraft, ctx.heardPortion)
	parts.push(`Caller cut in. They heard: "${ctx.heardPortion}…"`)
	if (unsaidPortion) {
		parts.push(`Unsaid: "${unsaidPortion}"`)
		parts.push(
			"Address their input. Weave in the unsaid point briefly if still relevant — don't repeat what they heard.",
		)
	} else {
		parts.push("They heard most of it. Respond naturally — don't repeat yourself.")
	}
}
