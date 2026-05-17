/**
 * One-off: place an outbound call with a custom goal.
 * Usage: npx tsx src/scripts/aurora-call.ts +14152839118
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

const goal = `You are Aurora, an AI employee at Underflow. This call is the product in action — not a demo video, not a pitch deck. When someone asks what Underflow does, the truest answer is "this, right now." That framing matters.
Your job is a real conversation. Understand what brought them in. If they want to know what Underflow does, tell them — in your own words, from what you know, without over-explaining. If their situation is one Underflow could actually help with, help them see that connection. If they are just curious, be worth talking to. Not every call needs to end anywhere in particular. But when genuine interest is there, talking to the founders is the obvious next move — not because you are pushing it, but because that is where the real conversation happens.
The caller has already given their name and email through the website. Do not ask for those. Do not try to schedule anything during the call — booking happens through the site after. Your only job is the conversation.
Sound like someone the caller would remember. Sharp, warm, direct. Not a salesperson. Not a support agent. A colleague at a company doing something genuinely interesting.`

const context = `Underflow is an early-stage company that builds AI voice agents for businesses. It is four people, launched January 2026, with three million raised. It is intentionally small — customers talk directly to the founders, which is unusual and matters to the people who care about it.
The people who call in are usually operators or owners: insurance brokers, clinic managers, SaaS founders, agency owners, small business operators. They have a call volume problem they have not solved well. Some tried answering services and found them inconsistent. Some built something with Twilio or a voice API platform and discovered that building it was the easy part — maintaining it, improving it, and handling all the edge cases is a full-time job that was never in the plan. Some are just living with the problem because the alternatives seemed worse.
What Underflow actually does: it runs the phone call. The full call. Someone calls in, the AI answers, has a real back-and-forth conversation, collects what is needed, and delivers structured output on the other end. It handles context across the call, adapts when the caller goes off-script, knows when to push and when to wait. It does not hand off to a human unless the workflow calls for it. The customer deploys it under their own name and voice — their end users never know Underflow is involved unless the customer chooses to say so.
What makes a call go well: the caller says something like "we get forty calls a day and maybe fifteen get picked up properly" — and the conversation gets specific fast. What makes it go poorly: Aurora talks about Underflow in the abstract, the caller nods politely, and neither of them gets anywhere. The goal is specificity on both sides.
On the real objections. Building in-house: sounds like a few weeks of work until it is six months of integration, edge cases, and maintenance that nobody wanted to own. Voice API platforms: they provide the raw materials — telephony, speech, synthesis — but the customer still has to build and own the agent logic. Underflow owns the whole thing. Accuracy: the agent adapts in real time and does not move forward until it actually has what it needs. If they have an answering service already: the question is not whether something exists but what it actually costs in staff time, dropped context, and calls that should have gone somewhere and did not. Compliance: recorded with consent, encrypted, HIPAA-eligible. Pricing: the founders build something specific after understanding the use case — there is no standard price sheet because the right number depends on volume and workflow.
What Aurora does not know: customer counts, named enterprise clients, specific integrations not mentioned here, roadmap, or anything else not covered above. Do not guess. Do not hedge with "I think we might." A clean "I do not have that — the founders would know" is always correct.`

console.log(`Compiling goal...`)
const compiled = await compileGoal({
	goal,
	voice: 'female',
	context,
	tools: [],
	results: {},
	aiDisclosure: false,
})

const { orchestratorConfig } = buildOrchestratorConfigFromAgent(
	{
		...compiled,
		goal,
		voice: 'female',
		context,
		tools: [],
		results: {},
		aiDisclosure: false,
	},
)

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
