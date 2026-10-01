/**
 * One-off: place an outbound call with a custom goal.
 * Usage: npx tsx src/scripts/aurora-call.ts +15551234567
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
	console.error('Usage: npx tsx src/scripts/aurora-call.ts <phone-number>')
	process.exit(1)
}

const goal = `You are Aurora, Underflow's voice assistant. Have a brief conversation that demonstrates the voice experience and answers the caller's questions about it. Let their questions guide the discussion. Explain relevant capabilities plainly, and ask a follow-up only when it helps answer their question. Curiosity, short answers, and complaints do not imply buying interest.
Use any caller details actually supplied at runtime. Do not assume they filled out a website form, have a call-volume problem, or want a founder meeting. Do not collect lead details, book meetings, or promise follow-up in this example. If they ask about a next step, describe only an available path. Respect a decline or goodbye immediately.`

const context = `Underflow builds AI voice agents for business phone conversations. This example demonstrates spoken back-and-forth, handling caller corrections, and collecting information relevant to a specific task. Mimic can organize the useful details from a call and connect to external services or actions made available for that call.
This example has no calendar, messaging, or human-transfer tool. No current price list, verified compliance statements, funding figures, customer references, or integration catalog is supplied. If asked for one of those facts, say it is not available in the provided information rather than infer an answer or make a promise. Do not present general competitor comparisons as facts.`

console.log(`Compiling goal...`)
const compiled = await compileGoal({
	goal,
	voice: 'female',
	context,
	tools: [],
	results: {},
	aiDisclosure: false,
})

const { orchestratorConfig } = buildOrchestratorConfigFromAgent({
	...compiled,
	goal,
	voice: 'female',
	context,
	tools: [],
	results: {},
	aiDisclosure: false,
})

console.log(`Dialing ${phone}...`)
const dialer = createSipDialer({
	livekitUrl: config.livekit.url,
	livekitApiKey: config.livekit.apiKey,
	livekitApiSecret: config.livekit.apiSecret,
	outboundTrunkId: config.livekit.sip.outboundTrunkId,
})

const roomName = `aurora-call-${Date.now()}`
await dialer.dial({ phoneNumber: phone, roomName })
console.log(`SIP dial successful, room: ${roomName}`)

let orchestratorRef: Awaited<ReturnType<typeof createCallOrchestrator>> | null = null

const { sessionComplete } = await createVoiceAgent({
	roomName,
	identity: 'aurora-agent',
	logPrefix: 'aurora-call',
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
