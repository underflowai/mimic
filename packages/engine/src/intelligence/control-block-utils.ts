/**
 * Control Block Utilities
 *
 * Shared signals appended to every per-turn control block (transcript quality,
 * tool lifecycle, end-call tag, interrupt context). The wording lives in
 * `prompts/control-block/*.md`; this module only decides which fragment to
 * emit and fills in the runtime values. Mimic itself does not build the
 * strategy block — consumers provide it via callbacks.
 */

import { loadPrompt, loadPromptTemplate, type PromptTemplate } from '#engine/prompts.js'

import { endCallTag } from '../audio/tts-sanitizer.js'
import type { InterruptContext } from './types.js'

export type { InterruptContext } from './types.js'

export interface ControlBlockPrompts {
	/** Shared caller-intent and data-boundary rules for compiled and persona agents. */
	turnPriorities: string
	/** Default cadence steer for persona-mode agents, which have no compiled text-quality block. */
	spokenCadence: string
	silenceFollowUp: string
	silenceClosing: string
	transcriptQuality: string
	toolRunning: string
	/** `{{toolList}}` — the JSON capability list. */
	toolsAvailable: PromptTemplate
	endCall: string
	/** JSON-encoded `{{heardPortion}}`, `{{unsaidPortion}}` (empty when no reliable remainder is available). */
	interrupt: PromptTemplate
	/** Director note used when tool intent classification throws. */
	toolClassificationFailed: string
	/** Appended while the caller's timezone is an area-code guess the caller hasn't confirmed. */
	timezoneGuess: string
}

function text(name: string) {
	return loadPrompt(`control-block/${name}`).then((raw) => raw.trim())
}

function template(name: string): Promise<PromptTemplate> {
	return loadPromptTemplate(`control-block/${name}`).then((render) => (data) => render(data).trim())
}

let cachedPrompts: Promise<ControlBlockPrompts> | null = null

/** Loads every control-block fragment once per process. */
export function loadControlBlockPrompts(): Promise<ControlBlockPrompts> {
	cachedPrompts ??= Promise.all([
		text('turn-priorities'),
		text('spoken-cadence'),
		text('silence-follow-up'),
		text('silence-closing'),
		text('transcript-quality'),
		text('tool-running'),
		template('tools-available'),
		template('end-call'),
		template('interrupt'),
		text('tool-classification-failed'),
		text('timezone-guess'),
	]).then(
		([
			turnPriorities,
			spokenCadence,
			silenceFollowUp,
			silenceClosing,
			transcriptQuality,
			toolRunning,
			toolsAvailable,
			endCall,
			interrupt,
			toolClassificationFailed,
			timezoneGuess,
		]) => ({
			turnPriorities,
			spokenCadence,
			silenceFollowUp,
			silenceClosing,
			transcriptQuality,
			toolRunning,
			toolsAvailable,
			endCall: endCall({ endCallTag }),
			interrupt,
			toolClassificationFailed,
			timezoneGuess,
		}),
	)
	return cachedPrompts
}

export interface FormatUserDateTimeOptions {
	/**
	 * The zone was guessed (from the caller's area code) rather than supplied.
	 * The rendered line says so, and the control block tells the agent to
	 * confirm it before leaning on it.
	 */
	inferred?: boolean
}

/** Appended to the date line when the zone is a guess. Prompts key off this wording. */
export const inferredTimezoneLabel = '(timezone guessed from the caller’s area code — unconfirmed)'

export function formatUserDateTime(timezone?: string, options?: FormatUserDateTimeOptions) {
	let tz = timezone?.trim() || 'UTC'
	let callerTimezoneKnown = Boolean(timezone?.trim())
	try {
		// Validate before formatting so a bad profile value cannot abort a voice turn.
		new Intl.DateTimeFormat('en-US', { timeZone: tz })
	} catch {
		tz = 'UTC'
		callerTimezoneKnown = false
	}
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
	const qualifier = !callerTimezoneKnown
		? ' (caller timezone unavailable; UTC reference)'
		: options?.inferred
			? ` ${inferredTimezoneLabel}`
			: ''
	return `${date}, ${time} ${tzAbbr}${qualifier}`
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

export function appendTranscriptQualityGuidance(parts: string[], prompts: ControlBlockPrompts) {
	parts.push(prompts.transcriptQuality)
}

// ── Tool lifecycle guidance ──────────────────────────────────────────

export interface ToolLifecycleContext {
	toolDefinitions?: Array<{ name: string; description: string }>
	executingTools?: string[]
	pendingTools?: string[]
}

export function appendToolLifecycleGuidance(parts: string[], ctx: ToolLifecycleContext, prompts: ControlBlockPrompts) {
	const executing = ctx.executingTools ?? []
	const pending = ctx.pendingTools ?? []

	if (executing.length > 0) {
		for (const note of executing) {
			parts.push(`Executing tool context (JSON string): ${JSON.stringify(note)}`)
		}
		parts.push(prompts.toolRunning)
	}

	if (pending.length > 0) {
		for (const nudge of pending) parts.push(`Tool coordination note (JSON string): ${JSON.stringify(nudge)}`)
	}

	if (executing.length > 0 || pending.length > 0) return

	const defs = ctx.toolDefinitions ?? []
	if (defs.length === 0) return

	const toolList = JSON.stringify(defs.map(({ name, description }) => ({ name, description })))
	parts.push(prompts.toolsAvailable({ toolList }))
}

// ── End-call guidance ────────────────────────────────────────────────

export function appendEndCallGuidance(parts: string[], prompts: ControlBlockPrompts) {
	parts.push(prompts.endCall)
}

// ── Interrupt context ───────────────────────────────────────────────

export function appendInterruptContext(parts: string[], ctx: InterruptContext | null, prompts: ControlBlockPrompts) {
	if (!ctx?.heardPortion) return
	const unsaidPortion = deriveUnsaidPortion(ctx.fullDraft, ctx.heardPortion)
	parts.push(
		prompts.interrupt({
			heardPortion: JSON.stringify(ctx.heardPortion),
			unsaidPortion: unsaidPortion ? JSON.stringify(unsaidPortion) : '',
		}),
	)
}
