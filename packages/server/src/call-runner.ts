/**
 * Background call runner.
 *
 * Dials a phone number via SIP, spawns a voice agent in the LiveKit room,
 * waits for the call to end, extracts results, and updates the DB.
 * Streams events to any connected WebSocket subscribers via the Redis call bus.
 */

import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { EgressClient, EncodedFileOutput, EncodedFileType, S3Upload } from 'livekit-server-sdk'
import OpenAI from 'openai'

import { config, createCallOrchestrator, type AudioTransport } from '@mimic/engine'
import { createVoiceAgent } from '@mimic/transport-livekit'

import { executeToolViaBus, publishCallEvent } from './call-bus.js'
import { getDb } from './db/index.js'
import { apiCalls, type ApiAgentRow, type ApiCallRow } from './db/schema.js'
import { buildOrchestratorConfigFromAgent, type AgentConfig } from './goal-compiler.js'
import { childLogger } from './logger.js'
import { extractCallResult, type ToolCallRecord, type TranscriptEntry } from './result-extractor.js'
import { createSipDialer } from './sip.js'
import { deliverWebhook } from './webhook.js'

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

async function getCallStatus(callId: string): Promise<ApiCallRow['status'] | null> {
	const db = getDb()
	const [call] = await db
		.select({ status: apiCalls.status })
		.from(apiCalls)
		.where(eq(apiCalls.id, callId))
		.limit(1)
	return call?.status ?? null
}

export async function runCall(call: ApiCallRow, agent: ApiAgentRow) {
	const callId = call.id
	childLogger({ callId, toPhone: call.toPhone }).info('starting call')

	try {
		const currentStatus = await getCallStatus(callId)
		if (currentStatus === 'cancelled') {
			childLogger({ callId }).info('call already cancelled before worker started')
			return
		}

		await updateCall(callId, { status: 'in_progress' })
		publishCallEvent(callId, { type: 'call_status', status: 'in_progress' })

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
		const toolCallRecords: ToolCallRecord[] = []

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
					executeTool: async (params: { toolName: string; toolArgs: Record<string, unknown> }) => {
						const outcome = await executeToolViaBus(callId, randomUUID(), params.toolName, params.toolArgs)
						toolCallRecords.push({
							name: params.toolName,
							input: params.toolArgs,
							output: 'result' in outcome ? outcome.result : outcome.error,
							success: !('error' in outcome),
						})
						return outcome
					},
					onTurnCommitted(turn) {
						publishCallEvent(callId, { type: 'speech', role: 'agent', text: turn.assistantResponse })
						if (turn.userTranscript) {
							publishCallEvent(callId, { type: 'speech', role: 'caller', text: turn.userTranscript })
						}
					},
				})
				orchestratorRef = orchestrator
				return orchestrator
			},
			connectServices: () => orchestratorRef!.connectServices(),
			async onSessionEnd(result: { turns: Array<{ role: string; content: string }>; durationSeconds: number } | null) {
				if (!result) return
				const statusBeforeFinalize = await getCallStatus(callId)
				if (statusBeforeFinalize === 'cancelled') {
					childLogger({ callId }).info('skipping completion write because call was cancelled')
					return
				}

				const transcript = result.turns.map((turn) => ({
					role: turn.role === 'agent' ? 'agent' : 'caller',
					content: turn.content,
				}))

				const extractionTranscript: TranscriptEntry[] = result.turns.map((turn) => ({
					role: turn.role === 'agent' ? 'assistant' : 'user',
					content: turn.content,
				}))

				const openai = new OpenAI({ apiKey: config.mimic.openai.apiKey })
				const extraction = await extractCallResult(openai, {
					goal: agent.goal,
					transcript: extractionTranscript,
					results: agent.results as Record<string, unknown>,
					toolCalls: toolCallRecords,
					successCondition: agent.successCondition as Parameters<typeof extractCallResult>[1]['successCondition'],
				})

				await updateCall(callId, {
					status: 'completed',
					transcript: transcript as unknown as ApiCallRow['transcript'],
					toolCalls: toolCallRecords as unknown as ApiCallRow['toolCalls'],
					result: extraction.result as unknown as ApiCallRow['result'],
					goalAchieved: extraction.goalAchieved,
					goalAchievedReason: extraction.goalAchievedReason,
					duration: result.durationSeconds,
					recordingPath: egressId ? `call-recordings/${callId}.ogg` : null,
				})

				publishCallEvent(callId, {
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

		const currentStatus = await getCallStatus(callId)
		if (currentStatus === 'cancelled') {
			publishCallEvent(callId, { type: 'call_status', status: 'cancelled' })
			return
		}

		await updateCall(callId, { status: 'failed', errorMessage }).catch(() => {})
		publishCallEvent(callId, { type: 'call_status', status: 'failed' })
		publishCallEvent(callId, { type: 'error', message: errorMessage })
	}
}
