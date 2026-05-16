/**
 * Backchannel Classifier — prompt sweep
 *
 * Exercises multiple prompt variants against the same set of clean and
 * messy transcripts, prints per-prompt distribution + a comparison matrix.
 *
 * Live API tests gate on RUN_LIVE_MIMIC_TESTS=1.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type OpenAI from 'openai'
import { z } from 'zod'

import { callBackgroundModel } from '#engine/llm-parse.js'
import { shouldRunLiveMimicTests } from '#test/support/live-test-gate.js'

// ---------------------------------------------------------------------------
// Tokens & schema (mirrors classifier.ts)
// ---------------------------------------------------------------------------

const backchannelTokens = ['mm-hmm', 'uh-huh', 'yeah', 'right', 'sure', 'got-it', 'i-see', 'okay'] as const

type BackchannelToken = (typeof backchannelTokens)[number]

const schema = z.object({
	token: z.enum(backchannelTokens).nullable(),
})

// ---------------------------------------------------------------------------
// Prompt variants to sweep
// ---------------------------------------------------------------------------

interface PromptVariant {
	name: string
	systemPrompt: string
	temperature: number
}

const variants: PromptVariant[] = [
	{
		name: 'A: current (examples, t=1)',
		temperature: 1,
		systemPrompt: `Backchannel classifier for a phone call. Decide whether to play an acknowledgment and which token. Vary your picks — do not over-use any single token.

STEP 1 — Check for skip conditions (if ANY match, return {"token":null}):
- Transcript is a question (ends with ? or asks for something)
- Caller sounds like they are wrapping up or making a request
- Sentence is clearly unfinished (no natural pause point)

STEP 2 — Only if no skip conditions matched, pick the best token:
"three claims, two auto, one property," → uh-huh (listing items)
"so I went ahead and called them back" → mm-hmm (encouraging / agreeing)
"turnaround time increased significantly" → right (point made)
"nobody called me back, three months" → i-see (frustration/surprise)
"premium jumped to eighteen hundred" → got-it (absorbing a fact/number)
"pull up the policy and add six trucks" → okay (instruction/action)
"we've been with them for about ten years" → yeah (casual acknowledgment)
"and they said it would be fully covered" → sure (confirmation/acceptance)

JSON: {"token":"yeah"} or {"token":null}`,
	},
	{
		name: 'B: semantic-only (no examples, t=1)',
		temperature: 1,
		systemPrompt: `Backchannel classifier for a phone call. Pick ONE acknowledgment token or null. Ignore filler words (uh, um, like, you know) — focus on the caller's meaning.

Return {"token":null} if the caller is asking a question, making a request, or mid-sentence with no pause.

Otherwise pick the single best token from this list. Each has a distinct purpose — spread your picks across them:
- mm-hmm: encouraging or agreeing
- uh-huh: tracking a list or sequence
- yeah: casual acknowledgment
- right: validating a strong point or complaint
- sure: accepting or confirming what they said
- got-it: absorbing a specific fact or number
- i-see: reacting to something surprising or notable
- okay: acknowledging an instruction or action item

JSON: {"token":"right"} or {"token":null}`,
	},
	{
		name: 'C: tone/intent mapping (t=1)',
		temperature: 1,
		systemPrompt: `Backchannel classifier for a phone call. Decide whether to acknowledge and which token. Ignore filler words and disfluencies — classify the underlying meaning.

Return {"token":null} if: question, request, or clearly unfinished sentence.

Otherwise match the caller's tone/intent to ONE token:
- Listing or sequencing items → uh-huh
- Encouraging or agreeing → mm-hmm
- Casual, low-stakes statement → yeah
- Strong point, complaint, emphasis → right
- Confirming or accepting something → sure
- Specific fact, number, detail → got-it
- Surprise, frustration, something notable → i-see
- Instruction, action, directive → okay

Do NOT default to any single token. Vary naturally.
JSON: {"token":"yeah"} or {"token":null}`,
	},
	{
		name: 'D: tone/intent + ASR note (t=1)',
		temperature: 1,
		systemPrompt: `Backchannel classifier for a phone call. The transcript comes from live ASR and contains filler words (uh, um, like, you know), false starts, and repetitions. Strip these mentally before classifying.

Return {"token":null} if: question, request, or clearly unfinished sentence.

Otherwise match the caller's underlying tone/intent to ONE token:
- Listing or sequencing items → uh-huh
- Encouraging or agreeing → mm-hmm
- Casual, low-stakes statement → yeah
- Strong point, complaint, emphasis → right
- Confirming or accepting something → sure
- Specific fact, number, detail → got-it
- Surprise, frustration, something notable → i-see
- Instruction, action, directive → okay

Do NOT default to any single token. Vary naturally.
JSON: {"token":"yeah"} or {"token":null}`,
	},
]

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

const cleanTranscripts = [
	'we had three claims last year, two auto and one property',
	'the turnaround time on those renewals has been really bad lately',
	'nobody called me back and it has been about three months now',
	'our premium jumped from twelve hundred to eighteen hundred',
	'that makes total sense I think that is the right approach here',
	'so go ahead and pull up the policy and add those six trucks',
	'we have been with them for about ten years now so it is a long relationship',
	'I talked to the underwriter already and she was very helpful about it',
	'they said it would be fully covered under the general liability section',
	'I went ahead and called them back last Tuesday about the endorsement',
]

const messyTranscripts = [
	'yeah so we had like uh three claims last year two auto one um one property I think',
	'the uh turnaround time on on those renewals has been like really really bad lately',
	'so nobody nobody called me back and its been about uh three months now so',
	'um the premium jumped from like twelve hundred to to eighteen hundred or something',
	'yeah that that makes sense I think thats thats the right approach here you know',
	'so go ahead and uh pull up the the policy and add those uh six trucks to it',
	'weve been with them for like about ten years now so its its a long relationship',
	'I I talked to the underwriter already and she was she was very helpful about it',
	'they said itd be fully covered under the the general liability section so thats good',
	'so I went ahead and uh called them back last Tuesday about the the endorsement thing',
	'we run a fleet of about uh forty trucks mostly in the the southeast region you know',
	'so the deductible on the on the commercial auto is like five thousand per per occurrence',
	'our loss ratio has actually been um improving quite a bit over the the past two years so',
	'the building is about uh fifteen thousand square feet its in an industrial park area',
	'we switched carriers last year because the the pricing was just was just too high',
	'the driver has a clean record no no accidents in the last like five years or so',
	'we uh added two new locations in Georgia and and one in South Carolina recently',
	'yeah the the cert holder needs to be uh updated before before Friday if possible',
	'the broker told us the the market is really really tightening up right now so yeah',
	'our revenue is up about uh thirty percent compared to to last year which is good',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getClient() {
	const OpenAIModule = (await import('openai')).default
	const { config } = await import('#engine/config.js')
	const apiKey = config.mimic.openai.apiKey
	if (!apiKey || apiKey === 'test-openai-key-for-unit-tests') return null
	return new OpenAIModule({ apiKey })
}

async function classifyWithPrompt(
	client: OpenAI,
	prompt: string,
	temperature: number,
	transcript: string,
): Promise<BackchannelToken | null> {
	const words = transcript.trim().split(/\s+/).filter(Boolean)
	if (words.length < 4) return null
	const snippet = words.slice(-50).join(' ')
	const result = await callBackgroundModel(client, prompt, snippet, schema, 'bc-sweep', {
		temperature,
		maxTokens: 50,
	})
	return result?.token ?? null
}

interface BatchResult {
	results: Array<{ transcript: string; token: string | null }>
	counts: Record<string, number>
	uniqueTokens: Set<string | null>
	topToken: string
	topPct: number
}

async function runBatch(client: OpenAI, variant: PromptVariant, transcripts: string[]): Promise<BatchResult> {
	const results: Array<{ transcript: string; token: string | null }> = []
	const counts: Record<string, number> = {}

	for (const transcript of transcripts) {
		let token: BackchannelToken | null = null
		try {
			token = await classifyWithPrompt(client, variant.systemPrompt, variant.temperature, transcript)
		} catch {
			/* JSON generation failure — treat as null */
		}
		results.push({ transcript, token })
		const key = token ?? '(null)'
		counts[key] = (counts[key] ?? 0) + 1
	}

	const uniqueTokens = new Set(results.map((r) => r.token).filter(Boolean))
	const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
	const [topToken, topCount] = sorted[0]
	const topPct = topCount / transcripts.length

	return { results, counts, uniqueTokens, topToken, topPct }
}

function printBatch(label: string, variant: PromptVariant, batch: BatchResult, total: number) {
	console.log(`\n--- ${label}: ${variant.name} ---`)
	const sorted = Object.entries(batch.counts).sort((a, b) => b[1] - a[1])
	for (const [token, count] of sorted) {
		const pct = ((count / total) * 100).toFixed(0)
		const bar = '█'.repeat(count)
		console.log(`  ${token.padEnd(16)} ${String(count).padStart(2)} (${pct.padStart(2)}%) ${bar}`)
	}
	console.log(`  unique: ${batch.uniqueTokens.size}  |  top: ${batch.topToken} @ ${(batch.topPct * 100).toFixed(0)}%`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backchannel prompt sweep (live API)', () => {
	it('sweeps all variants and prints comparison', async (ctx) => {
		if (!shouldRunLiveMimicTests()) {
			ctx.skip()
			return
		}
		const client = await getClient()
		if (!client) {
			ctx.skip()
			return
		}

		const cleanResults: Array<{ variant: PromptVariant; batch: BatchResult }> = []
		const messyResults: Array<{ variant: PromptVariant; batch: BatchResult }> = []

		for (const variant of variants) {
			const clean = await runBatch(client, variant, cleanTranscripts)
			printBatch('Clean', variant, clean, cleanTranscripts.length)

			const messy = await runBatch(client, variant, messyTranscripts)
			printBatch('Messy', variant, messy, messyTranscripts.length)

			cleanResults.push({ variant, batch: clean })
			messyResults.push({ variant, batch: messy })
		}

		// --- Comparison matrix ---
		console.log('\n\n========== COMPARISON MATRIX ==========\n')

		const header = [
			'Variant'.padEnd(40),
			'Clean unique',
			'Clean top',
			'Clean top%',
			'Messy unique',
			'Messy top',
			'Messy top%',
		].join(' | ')
		console.log(header)
		console.log('-'.repeat(header.length))

		for (let i = 0; i < variants.length; i++) {
			const c = cleanResults[i].batch
			const m = messyResults[i].batch
			const row = [
				variants[i].name.padEnd(40),
				String(c.uniqueTokens.size).padStart(12),
				c.topToken.padStart(9),
				`${(c.topPct * 100).toFixed(0)}%`.padStart(10),
				String(m.uniqueTokens.size).padStart(12),
				m.topToken.padStart(9),
				`${(m.topPct * 100).toFixed(0)}%`.padStart(10),
			].join(' | ')
			console.log(row)
		}

		// --- Per-transcript matrix (messy only, shows token per variant) ---
		console.log('\n\n========== MESSY PER-TRANSCRIPT MATRIX ==========\n')
		const tHeader = ['Transcript'.padEnd(55), ...variants.map((v) => v.name.slice(0, 2).padStart(6))].join(' | ')
		console.log(tHeader)
		console.log('-'.repeat(tHeader.length))

		for (let t = 0; t < messyTranscripts.length; t++) {
			const cols = [
				messyTranscripts[t].slice(0, 55).padEnd(55),
				...messyResults.map((r) => (r.batch.results[t].token ?? 'null').slice(0, 6).padStart(6)),
			]
			console.log(cols.join(' | '))
		}

		console.log('\n')

		const bestMessyUnique = Math.max(...messyResults.map((r) => r.batch.uniqueTokens.size))
		assert.ok(bestMessyUnique >= 4, `Best variant only got ${bestMessyUnique} unique tokens on messy`)
	})
})
