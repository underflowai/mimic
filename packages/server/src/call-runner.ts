/**
 * Background call runner.
 *
 * Dials a phone number via SIP, spawns a voice agent in the LiveKit room,
 * waits for the call to end, extracts results, and updates the DB.
 * Streams events to any connected WebSocket subscribers.
 */

import { eq } from 'drizzle-orm'

import { config } from '@mimic/engine/src/config.js'
import { createCallOrchestrator } from '@mimic/engine/src/orchestrator.js'
import type { AudioTransport } from '@mimic/engine/src/audio/streams/types.js'
import { createVoiceAgent } from '@mimic/transport-livekit'

import { getDb } from './db/index.js'
import { apiCalls, type ApiAgentRow, type ApiCallRow } from './db/schema.js'
import { buildOrchestratorConfigFromAgent, type AgentConfig } from './goal-compiler.js'
import { extractCallResult, type TranscriptEntry } from './result-extractor.js'
import { createSipDialer } from './sip.js'
import { deliverWebhook } from './webhook.js'

import OpenAI from 'openai'

type EventCallback = (event: Record<string, unknown>) => void

const activeCallSubscribers = new Map<string, Set<EventCallback>>()

export function subscribeToCall(callId: string, callback: EventCallback): () => void {
	let subs = activeCallSubscribers.get(callId)
	if (!subs) {
		subs = new Set()
		activeCallSubscribers.set(callId, subs)
	}
	subs.add(callback)
	return () => {
		subs!.delete(callback)
		if (subs!.size === 0) activeCallSubscribers.delete(callId)
	}
}

function broadcast(callId: string, event: Record<string, unknown>) {
	const subs = activeCallSubscribers.get(callId)
	if (!subs) return
	for (const cb of subs) {
		try {
			cb(event)
		} catch {}
	}
}

function agentRowToConfig(row: ApiAgentRow): AgentConfig {
	return {
		systemPrompt: row.systemPrompt,
		turnControlBlock: row.turnControlBlock ?? undefined,
		agentName: row.agentName,
		goal: row.goal,
		voice: row.voice as 'female' | 'male',
		context: row.context as Record<string, string>,
		tools: row.tools as AgentConfig['tools'],
		results: row.results as Record<string, unknown>,
		aiDisclosure: true,
	}
}

async function updateCall(callId: string, updates: Partial<ApiCallRow>) {
	const db = getDb()
	await db.update(apiCalls).set({ ...updates, updatedAt: new Date() }).where(eq(apiCalls.id, callId))
}

export async function runCall(call: ApiCallRow, agent: ApiAgentRow) {
	const callId = call.id
	console.log(`[call-runner] Starting call ${callId} to ${call.toPhone}`)

	try {
		await updateCall(callId, { status: 'in_progress' })
		broadcast(callId, { type: 'call_status', status: 'in_progress' })

		const dialer = createSipDialer({
			livekitUrl: config.livekit.url,
			livekitApiKey: config.livekit.apiKey,
			livekitApiSecret: config.livekit.apiSecret,
			outboundTrunkId: config.livekit.sip.outboundTrunkId,
		})

		const roomName = `mimic-call-${callId}`
		await dialer.dial({
			phoneNumber: call.toPhone,
			roomName,
			participantIdentity: `caller-${callId}`,
			participantName: call.toPhone,
		})

		console.log(`[call-runner] SIP dial successful, room: ${roomName}`)

		const agentConfig = agentRowToConfig(agent)
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(
			agentConfig,
			call.callContext as Record<string, string> | undefined,
		)

		let orchestratorRef: Awaited<ReturnType<typeof createCallOrchestrator>> | null = null

		const { sessionComplete } = await createVoiceAgent({
			roomName,
			identity: `mimic-agent-${callId}`,
			logPrefix: `call-${callId}`,
			livekitUrl: config.livekit.url,
			livekitAgentUrl: config.livekit.agentUrl,
			livekitApiKey: config.livekit.apiKey,
			livekitApiSecret: config.livekit.apiSecret,
			createOrchestrator: async (transport: AudioTransport) => {
				const orchestrator = await createCallOrchestrator({
					...orchestratorConfig,
					callId,
					audioTransport: transport,
					onTurnCommitted(turn) {
						broadcast(callId, { type: 'speech', role: 'agent', text: turn.assistantResponse })
						if (turn.userTranscript) {
							broadcast(callId, { type: 'speech', role: 'caller', text: turn.userTranscript })
						}
					},
				})
				orchestratorRef = orchestrator
				return orchestrator
			},
			connectServices: () => orchestratorRef!.connectServices(),
			async onSessionEnd(result: { turns: Array<{ role: string; content: string }>; durationSeconds: number } | null) {
				if (!result) return

				const transcript: TranscriptEntry[] = result.turns.map((turn) => ({
					role: turn.role === 'agent' ? 'assistant' : 'user',
					content: turn.content,
				}))

				const openai = new OpenAI({ apiKey: config.mimic.openai.apiKey })
				const extraction = await extractCallResult(openai, {
					goal: agent.goal,
					transcript,
					results: agent.results as Record<string, unknown>,
					successCondition: agent.successCondition as Parameters<typeof extractCallResult>[1]['successCondition'],
				})

				await updateCall(callId, {
					status: 'completed',
					transcript: transcript as unknown as ApiCallRow['transcript'],
					result: extraction.result as unknown as ApiCallRow['result'],
					goalAchieved: extraction.goalAchieved,
					goalAchievedReason: extraction.goalAchievedReason,
					duration: result.durationSeconds,
				})

				broadcast(callId, {
					type: 'done',
					goalAchieved: extraction.goalAchieved,
					goalAchievedReason: extraction.goalAchievedReason,
				})

				if (agent.webhook) {
					await deliverWebhook({
						url: agent.webhook,
						payload: {
							event: 'call.completed',
							callId,
							result: extraction,
							transcript,
						},
					}).catch((err) => console.error(`[call-runner] Webhook delivery failed:`, err))
				}

				console.log(`[call-runner] Call ${callId} completed (${result.durationSeconds}s)`)
			},
		})

		await sessionComplete
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err)
		console.error(`[call-runner] Call ${callId} failed:`, errorMessage)

		await updateCall(callId, { status: 'failed', errorMessage }).catch(() => {})
		broadcast(callId, { type: 'call_status', status: 'failed' })
		broadcast(callId, { type: 'error', message: errorMessage })
	}
}
