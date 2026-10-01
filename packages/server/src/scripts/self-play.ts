/**
 * Audio self-play harness (improvements.md §6.2).
 *
 * Agent-vs-agent at the audio level: the real orchestrator (Cartesia
 * TTS, Deepgram Flux, Silero VAD, turn machine, speculation) runs
 * against a synthetic caller — an LLM persona speaking through its own
 * TTS voice — over a loopback AudioTransport with realtime pacing. This
 * exercises EOT, barge-in, and the sanitizer exactly as a phone call
 * would, without dialing a human.
 *
 * The transcript is scored with the agent's compile-time rubric
 * (api_agents.evals) and results are written to disk keyed by the
 * agent's configHash, so every agent version carries its own test
 * results.
 *
 * Usage:
 *   pnpm --filter @mimic/server exec tsx src/scripts/self-play.ts --agent-id <uuid> \
 *     [--persona <persona-id>] [--data '{"appointmentDate":"Tuesday 2 PM"}'] \
 *     [--max-seconds 180] [--out self-play-results]
 *
 * Requires: OPENAI_API_KEY, CARTESIA_API_KEY, DEEPGRAM_API_KEY, DATABASE_URL.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { eq } from 'drizzle-orm'
import OpenAI from 'openai'
import { z } from 'zod'

import {
	arloPersona,
	auroraPersona,
	config,
	createCallOrchestrator,
	createListenTranscriber,
	createTtsSpeaker,
	serializeEventLog,
	type AudioSink,
	type AudioTransport,
} from '@mimic/engine'

import type { AgentSpec } from '../agent-spec.js'
import type { AgentEvals, EvalPersona } from '../eval-generator.js'
import { getDb } from '../db/index.js'
import { apiAgents } from '../db/schema.js'
import { buildOrchestratorConfigFromAgent, type AgentConfig } from '../goal-compiler.js'

// ── Audio constants ───────────────────────────────────────────────────

const AGENT_SAMPLE_RATE = 48_000
const CALLER_SAMPLE_RATE = 16_000
const FRAME_MS = 20
const CALLER_FRAME_BYTES = (CALLER_SAMPLE_RATE / 1000) * FRAME_MS * 2 // 640
const AGENT_BYTES_PER_MS = (AGENT_SAMPLE_RATE / 1000) * 2 // 96

// ── CLI args ──────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag)
	return i !== -1 ? process.argv[i + 1] : undefined
}

// ── Loopback transport ────────────────────────────────────────────────

/**
 * AudioTransport that paces agent PCM against a realtime playhead and
 * forwards each frame to the synthetic caller's ear at the moment it
 * would have been heard on a phone.
 */
function createLoopbackTransport(onAgentAudio: (chunk: Buffer) => void) {
	let open = true
	let playheadAt = Date.now()
	const pending = new Set<ReturnType<typeof setTimeout>>()

	function schedule(chunk: Buffer) {
		const now = Date.now()
		playheadAt = Math.max(playheadAt, now)
		const deliverInMs = playheadAt - now
		playheadAt += chunk.length / AGENT_BYTES_PER_MS
		const timer = setTimeout(() => {
			pending.delete(timer)
			if (open) onAgentAudio(chunk)
		}, deliverInMs)
		pending.add(timer)
	}

	function createSink(): AudioSink {
		const sink = new Writable({
			highWaterMark: 1 << 22,
			write(chunk: Buffer, _enc, cb) {
				schedule(chunk)
				cb()
			},
		}) as Writable & {
			waitForPlayout(): Promise<void>
			clearQueue(): void
			writeFrameDirect(chunk: Buffer): Promise<void>
		}
		sink.waitForPlayout = () => new Promise((resolve) => setTimeout(resolve, Math.max(0, playheadAt - Date.now())))
		sink.clearQueue = () => {
			for (const timer of pending) clearTimeout(timer)
			pending.clear()
			playheadAt = Date.now()
		}
		sink.writeFrameDirect = async (chunk: Buffer) => schedule(chunk)
		return sink as AudioSink
	}

	const transport: AudioTransport = {
		createSink,
		playBackchannelFrame: (chunk) => schedule(chunk),
		isOpen: () => open,
		close: async () => {
			open = false
			for (const timer of pending) clearTimeout(timer)
			pending.clear()
		},
	}
	return { transport, isAgentAudioPending: () => Date.now() < playheadAt }
}

// ── Audio helpers ─────────────────────────────────────────────────────

/** Decimate 48 kHz s16le mono to 16 kHz with a 3-sample boxcar. */
function downsample48to16(pcm48: Buffer): Buffer {
	const inSamples = Math.floor(pcm48.length / 2)
	const outSamples = Math.floor(inSamples / 3)
	const out = Buffer.alloc(outSamples * 2)
	for (let i = 0; i < outSamples; i++) {
		const base = i * 3
		const sum =
			pcm48.readInt16LE(base * 2) +
			pcm48.readInt16LE((base + 1) * 2) +
			pcm48.readInt16LE(Math.min(base + 2, inSamples - 1) * 2)
		out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 3))), i * 2)
	}
	return out
}

// ── Synthetic caller ──────────────────────────────────────────────────

const callerReplySchema = z.object({
	reply: z.string(),
	/** Milliseconds the caller "thinks" before starting to speak. */
	thinkingDelayMs: z.number().int().min(0).max(4000).default(600),
	hangup: z.boolean().default(false),
})

const DEFAULT_PERSONA: EvalPersona = {
	id: 'cooperative-baseline',
	name: 'Cooperative baseline caller',
	persona:
		'You are an ordinary, mildly busy person answering your phone. You answer questions directly, ' +
		'occasionally ask for one clarification, and speak in short natural sentences.',
	stresses: [],
	difficulty: 'easy',
}

interface SyntheticCaller {
	/** Feed one agent utterance (what the caller just heard). */
	onAgentUtterance: (text: string) => void
	stop: () => void
	transcriptView: () => string[]
}

function createSyntheticCaller(opts: {
	persona: EvalPersona
	goalSummary: string
	openai: OpenAI
	voiceId: string
	speak: (pcm16k: Buffer) => void
	onHangup: () => void
}): SyntheticCaller {
	const history: Array<{ role: 'agent' | 'caller'; text: string }> = []
	const tts = createTtsSpeaker({ voiceId: opts.voiceId })
	let stopped = false
	let generation = 0

	const systemPrompt = [
		opts.persona.persona,
		'',
		'You are on a PHONE CALL. You just heard the other party speak. Reply as this person would, out loud.',
		'Rules: reply in 1-2 short spoken sentences, plain text, no markdown, no stage directions.',
		'Stay in character. You may be difficult exactly the way your persona is difficult, but you are a real human on a phone.',
		'If the conversation has clearly concluded (goodbyes exchanged, or you would realistically hang up), set hangup=true.',
		`Context you may or may not know about: the other party's aim is: ${opts.goalSummary}`,
		'Return JSON: { "reply": string, "thinkingDelayMs": number (0-4000, how long you pause before speaking), "hangup": boolean }',
	].join('\n')

	async function respond(agentText: string) {
		const myGeneration = ++generation
		history.push({ role: 'agent', text: agentText })

		const completion = await opts.openai.chat.completions.create({
			model: 'gpt-5.4-mini',
			temperature: 0.9,
			max_completion_tokens: 300,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: systemPrompt },
				...history.map((h) => ({
					role: h.role === 'agent' ? ('user' as const) : ('assistant' as const),
					content: h.text,
				})),
			],
		})
		if (stopped || myGeneration !== generation) return

		const parsed = callerReplySchema.safeParse(JSON.parse(completion.choices[0]?.message?.content ?? '{}'))
		if (!parsed.success) return
		const { reply, thinkingDelayMs, hangup } = parsed.data

		if (hangup && !reply.trim()) {
			opts.onHangup()
			return
		}

		await new Promise((r) => setTimeout(r, thinkingDelayMs))
		if (stopped || myGeneration !== generation) return

		history.push({ role: 'caller', text: reply })
		const chunks: Buffer[] = []
		const handle = await tts.preSendTextForSynthesis(reply, (chunk48) => chunks.push(chunk48))
		handle.triggerSynthesisStart()
		await handle.audioComplete
		if (stopped || myGeneration !== generation) return

		const pcm16k = downsample48to16(Buffer.concat(chunks))
		opts.speak(pcm16k)

		if (hangup) {
			// Let the goodbye play out, then hang up.
			const speechMs = pcm16k.length / ((CALLER_SAMPLE_RATE / 1000) * 2)
			setTimeout(() => opts.onHangup(), speechMs + 1500)
		}
	}

	void tts.connect().catch((err) => console.error('caller TTS connect failed:', err))

	return {
		onAgentUtterance(text: string) {
			if (stopped) return
			void respond(text).catch((err) => console.error('synthetic caller failed to respond:', err))
		},
		stop() {
			stopped = true
			generation++
			tts.close()
		},
		transcriptView: () => history.map((h) => `${h.role}: ${h.text}`),
	}
}

// ── Judge ─────────────────────────────────────────────────────────────

const judgeResultSchema = z.object({
	scores: z.array(
		z.object({
			id: z.string(),
			pass: z.boolean(),
			rationale: z.string(),
		}),
	),
})

async function judgeTranscript(
	openai: OpenAI,
	evals: AgentEvals,
	spec: AgentSpec | null,
	transcript: Array<{ role: string; content: string }>,
) {
	const rubricBlock = evals.rubric.map((r) => `- [${r.id}] (weight ${r.weight}) ${r.criterion}`).join('\n')
	const transcriptBlock = transcript.map((t) => `${t.role}: ${t.content}`).join('\n')
	const specBlock = spec
		? `mustCollect: ${spec.mustCollect.join(', ') || 'none'}\nmustVerify: ${spec.mustVerify.join(', ') || 'none'}\nprohibited: ${spec.prohibited.join('; ') || 'none'}`
		: 'none'

	const completion = await openai.chat.completions.create({
		model: 'gpt-5.4',
		temperature: 0,
		max_completion_tokens: 3000,
		response_format: { type: 'json_object' },
		messages: [
			{
				role: 'system',
				content:
					'You judge AI phone agent transcripts against a rubric. For each rubric item, decide pass/fail strictly from the transcript. ' +
					'Return JSON: { "scores": [{ "id", "pass", "rationale" }] } with one entry per rubric item.',
			},
			{
				role: 'user',
				content: `Agent contract:\n${specBlock}\n\nRubric:\n${rubricBlock}\n\nTranscript:\n${transcriptBlock}`,
			},
		],
	})

	const parsed = judgeResultSchema.parse(JSON.parse(completion.choices[0]?.message?.content ?? '{}'))
	const byId = new Map(parsed.scores.map((s) => [s.id, s]))
	let earned = 0
	let possible = 0
	for (const item of evals.rubric) {
		possible += item.weight
		if (byId.get(item.id)?.pass) earned += item.weight
	}
	return { scores: parsed.scores, earned, possible }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
	const agentId = argValue('--agent-id')
	if (!agentId) throw new Error('--agent-id is required')
	const personaId = argValue('--persona')
	const maxSeconds = Number(argValue('--max-seconds') ?? 180)
	const outDir = argValue('--out') ?? 'self-play-results'
	const callData = argValue('--data') ? (JSON.parse(argValue('--data')!) as Record<string, unknown>) : null

	const db = getDb()
	const [agent] = await db.select().from(apiAgents).where(eq(apiAgents.id, agentId)).limit(1)
	if (!agent) throw new Error(`agent ${agentId} not found`)
	if (!agent.systemPrompt) throw new Error(`agent ${agentId} has no compiled prompt yet`)

	const evals = (agent.evals as AgentEvals | null) ?? null
	const spec = (agent.agentSpec as AgentSpec | null) ?? null
	const persona = personaId
		? (evals?.personas.find((p) => p.id === personaId) ??
			(() => {
				throw new Error(
					`persona "${personaId}" not found; available: ${evals?.personas.map((p) => p.id).join(', ') || '(none — run a compile first)'}`,
				)
			})())
		: (evals?.personas[0] ?? DEFAULT_PERSONA)

	console.log(`agent: ${agent.name}`)
	console.log(`persona: ${persona.id} (${persona.difficulty})`)

	const agentConfig: AgentConfig = {
		systemPrompt: agent.systemPrompt,
		turnControlBlock: agent.turnControlBlock ?? undefined,
		agentName: agent.agentName,
		goal: agent.goal,
		voice: agent.voice as 'female' | 'male',
		context: agent.context as Record<string, string>,
		tools: agent.tools as AgentConfig['tools'],
		results: agent.results as Record<string, unknown>,
		aiDisclosure: true,
		agentSpec: spec,
	}
	const { orchestratorConfig } = buildOrchestratorConfigFromAgent(agentConfig, undefined, callData)

	const openai = new OpenAI({ apiKey: config.mimic.openai.apiKey })

	// Caller speech queue → orchestrator, paced at one frame per 20ms with
	// silence fill so VAD and Flux see a continuous stream.
	const callerFrameQueue: Buffer[] = []
	const silenceFrame = Buffer.alloc(CALLER_FRAME_BYTES)

	// Synthetic caller's ear: Flux EOT on the agent's audio decides when
	// the caller heard a complete utterance.
	const callerEar = createListenTranscriber({ encoding: 'linear16', sampleRate: AGENT_SAMPLE_RATE })

	const { transport } = createLoopbackTransport((agentChunk) => callerEar.sendAudio(agentChunk))

	let done: (reason: string) => void
	const finished = new Promise<string>((resolve) => {
		done = resolve
	})

	const orchestrator = await createCallOrchestrator({
		...orchestratorConfig,
		callId: `selfplay-${agentId.slice(0, 8)}-${Date.now()}`,
		audioTransport: transport,
		// Simulated tool executor: plausible, deterministic, never blocks.
		executeTool: async ({ toolName, toolArgs }) => ({
			result: `SIMULATED ${toolName} ok: ${JSON.stringify(toolArgs)}`,
		}),
	})

	const caller = createSyntheticCaller({
		persona,
		goalSummary: agent.goal,
		openai,
		voiceId: agentConfig.voice === 'male' ? auroraPersona.ttsVoiceId : arloPersona.ttsVoiceId,
		speak(pcm16k) {
			for (let offset = 0; offset < pcm16k.length; offset += CALLER_FRAME_BYTES) {
				const frame = pcm16k.subarray(offset, offset + CALLER_FRAME_BYTES)
				callerFrameQueue.push(frame.length === CALLER_FRAME_BYTES ? frame : Buffer.concat([frame], CALLER_FRAME_BYTES))
			}
		},
		onHangup: () => done('caller hangup'),
	})

	callerEar.on('turnComplete', (_turns, latest) => caller.onAgentUtterance(latest.content))
	orchestrator.onHangupRequested(() => done('agent hangup'))

	const feedInterval = setInterval(() => {
		orchestrator.handleCallerAudio(callerFrameQueue.shift() ?? silenceFrame)
	}, FRAME_MS)

	const timeout = setTimeout(() => done('timeout'), maxSeconds * 1000)

	await callerEar.connect()
	await orchestrator.connectServices()
	await orchestrator.start()
	console.log('call started — agent is speaking first')

	const endReason = await finished
	console.log(`call ended: ${endReason}`)

	clearInterval(feedInterval)
	clearTimeout(timeout)
	caller.stop()
	await callerEar.close().catch(() => {})
	const result = await orchestrator.close()
	await transport.close()

	const transcript = result.turns.map((t: { role: string; content: string }) => ({
		role: t.role === 'assistant' ? 'agent' : 'caller',
		content: t.content,
	}))

	let judgment: Awaited<ReturnType<typeof judgeTranscript>> | null = null
	if (evals && transcript.length > 0) {
		judgment = await judgeTranscript(openai, evals, spec, transcript)
	}

	const key = (agent.configHash ?? agentId).slice(0, 16)
	const dir = join(outDir, key)
	mkdirSync(dir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const base = join(dir, `${persona.id}-${stamp}`)

	writeFileSync(
		`${base}.json`,
		JSON.stringify(
			{
				agentId,
				configHash: agent.configHash,
				persona: persona.id,
				difficulty: persona.difficulty,
				endReason,
				durationSeconds: result.durationSeconds,
				turnCount: result.turnCount,
				score: judgment ? { earned: judgment.earned, possible: judgment.possible, detail: judgment.scores } : null,
				transcript,
				metrics: result.metrics,
			},
			null,
			2,
		),
	)
	writeFileSync(`${base}.events.jsonl`, serializeEventLog(result.eventLog))

	console.log(`\nresults → ${base}.json`)
	if (judgment) {
		console.log(`score: ${judgment.earned}/${judgment.possible}`)
		for (const s of judgment.scores) {
			console.log(`  ${s.pass ? 'PASS' : 'FAIL'} [${s.id}] ${s.rationale}`)
		}
	} else {
		console.log('no rubric on this agent (evals missing) — transcript saved unscored')
	}

	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
