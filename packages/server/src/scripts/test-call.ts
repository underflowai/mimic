/**
 * Test: place an outbound call locally.
 * Usage: npx tsx src/scripts/test-call.ts +15551234567
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const envFile = readFileSync(resolve(import.meta.dirname, '../../../../.env'), 'utf8')
for (const line of envFile.split('\n')) {
	const trimmed = line.trim()
	if (!trimmed || trimmed.startsWith('#')) continue
	const eqIdx = trimmed.indexOf('=')
	if (eqIdx > 0) process.env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
}

import { config, createCallOrchestrator, type AudioTransport } from '@mimic/engine'
import { createVoiceAgent } from '@mimic/transport-livekit'

import { createSipDialer } from '../sip.js'
import { compileGoal, buildOrchestratorConfigFromAgent } from '../goal-compiler.js'

const phone = process.argv[2]
if (!phone) {
	console.error('Usage: npx tsx src/scripts/test-call.ts <phone-number>')
	process.exit(1)
}

console.log(`Compiling goal...`)
const compiled = await compileGoal({
	goal: 'Say hello and have a brief friendly conversation. Ask how their day is going.',
	voice: 'female',
	context: {},
	tools: [],
	results: {},
})

const { orchestratorConfig } = buildOrchestratorConfigFromAgent(
	{
		...compiled,
		goal: 'Say hello and have a brief friendly conversation',
		voice: 'female',
		context: {},
		tools: [],
		results: {},
		aiDisclosure: true,
	},
)

console.log(`Dialing ${phone}...`)
const dialer = createSipDialer({
	livekitUrl: config.livekit.url,
	livekitApiKey: config.livekit.apiKey,
	livekitApiSecret: config.livekit.apiSecret,
	outboundTrunkId: config.livekit.sip.outboundTrunkId,
})

const roomName = `test-call-${Date.now()}`
await dialer.dial({ phoneNumber: phone, roomName })
console.log(`SIP dial successful, room: ${roomName}`)

let orchestratorRef: Awaited<ReturnType<typeof createCallOrchestrator>> | null = null

const { sessionComplete } = await createVoiceAgent({
	roomName,
	identity: 'mimic-test-agent',
	logPrefix: 'test-call',
	livekitUrl: config.livekit.url,
	livekitApiKey: config.livekit.apiKey,
	livekitApiSecret: config.livekit.apiSecret,
	createOrchestrator: async (transport: AudioTransport) => {
		const orchestrator = await createCallOrchestrator({
			...orchestratorConfig,
			audioTransport: transport,
			onTurnCommitted(turn) {
				if (turn.userTranscript) console.log(`[caller] ${turn.userTranscript}`)
				console.log(`[agent] ${turn.assistantResponse}`)
			},
		})
		orchestratorRef = orchestrator
		return orchestrator
	},
	connectServices: () => orchestratorRef!.connectServices(),
	async onSessionEnd(result) {
		if (result) {
			console.log(`\nCall ended: ${result.durationSeconds}s, ${result.turnCount} turns`)
		}
		process.exit(0)
	},
})

console.log('Voice agent joined room, waiting for call to end...')
await sessionComplete
