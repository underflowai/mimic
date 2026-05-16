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
import { childLogger } from './logger.js'
import { randomUUID } from 'node:crypto'
import { EgressClient, EncodedFileOutput, EncodedFileType, S3Upload } from 'livekit-server-sdk'
import { decrementActiveCalls } from './middleware/rate-limit.js'

type EventCallback = (event: Record<string, unknown>) => void
type ToolCallbackFn = (toolName: string, toolArgs: Record<string, unknown>, callbackId: string) => Promise<{ result: string } | { error: string }>

export interface ToolHandler {
	unregister: () => void
}

const activeCallSubscribers = new Map<string, Set<EventCallback>>()
const activeToolHandlers = new Map<string, ToolCallbackFn>()

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

export function registerToolHandler(callId: string, handler: ToolCallbackFn): ToolHandler {
	activeToolHandlers.set(callId, handler)
	return {
		unregister: () => activeToolHandlers.delete(callId),
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

async function executeToolViaWebSocket(callId: string, toolName: string, toolArgs: Record<string, unknown>): Promise<{ result: string } | { error: string }> {
	const handler = activeToolHandlers.get(callId)
	if (!handler) return { error: 'No SDK tool handler connected' }
	const callbackId = randomUUID()
	return handler(toolName, toolArgs, callbackId)
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
	childLogger({ callId, toPhone: call.toPhone }).info('starting call')

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

		childLogger({ callId, roomName }).info('SIP dial successful')

		const agentConfig = agentRowToConfig(agent)
		const { orchestratorConfig } = buildOrchestratorConfigFromAgent(
			agentConfig,
			call.callContext as Record<string, string> | undefined,
		)

		let orchestratorRef: Awaited<ReturnType<typeof createCallOrchestrator>> | null = null
		let egressId: string | null = null

		const ambienceEnabled = (agent.ambience as boolean | null) !== false
		const recordingEnabled = Boolean(process.env.RECORDING_S3_BUCKET)

		const { sessionComplete } = await createVoiceAgent({
			roomName,
			identity: `mimic-agent-${callId}`,
			logPrefix: `call-${callId}`,
			livekitUrl: config.livekit.url,
			livekitAgentUrl: config.livekit.agentUrl,
			livekitApiKey: config.livekit.apiKey,
			livekitApiSecret: config.livekit.apiSecret,
			ambience: { enabled: ambienceEnabled },
			async onReady() {
				if (!recordingEnabled) return
				try {
					const egressClient = new EgressClient(config.livekit.url, config.livekit.apiKey, config.livekit.apiSecret)
					const info = await egressClient.startRoomCompositeEgress(
						roomName,
						{
							file: new EncodedFileOutput({
								filepath: `call-recordings/${callId}.ogg`,
								fileType: EncodedFileType.OGG,
								output: {
									case: 's3',
									value: new S3Upload({
										accessKey: process.env.RECORDING_S3_ACCESS_KEY ?? '',
										secret: process.env.RECORDING_S3_SECRET ?? '',
										bucket: process.env.RECORDING_S3_BUCKET ?? '',
										region: process.env.RECORDING_S3_REGION ?? 'us-east-1',
										endpoint: process.env.RECORDING_S3_ENDPOINT ?? '',
									}),
								},
							}),
						},
						{ audioOnly: true },
					)
					egressId = info.egressId
					childLogger({ callId, egressId }).info('started recording')
				} catch (err) {
					childLogger({ callId, err }).error('failed to start recording')
				}
			},
			createOrchestrator: async (transport: AudioTransport) => {
				const orchestrator = await createCallOrchestrator({
					...orchestratorConfig,
					callId,
					audioTransport: transport,
					executeTool: async (params: { toolName: string; toolArgs: Record<string, unknown> }) => executeToolViaWebSocket(callId, params.toolName, params.toolArgs),
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
					recordingPath: egressId ? `call-recordings/${callId}.ogg` : null,
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
					}).catch((err) => childLogger({ callId, err }).error('webhook delivery failed'))
				}

				childLogger({ callId, durationSeconds: result.durationSeconds }).info('call completed')
			},
		})

		await sessionComplete
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err)
		childLogger({ callId, errorMessage }).error('call failed')

		await updateCall(callId, { status: 'failed', errorMessage }).catch(() => {})
		broadcast(callId, { type: 'call_status', status: 'failed' })
		broadcast(callId, { type: 'error', message: errorMessage })
	} finally {
		decrementActiveCalls(call.apiKeyId)
	}
}
