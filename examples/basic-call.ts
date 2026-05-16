/**
 * Basic voice call example.
 *
 * Creates an orchestrator with a simple system prompt and connects it
 * to a LiveKit room. The agent greets the caller and has a conversation.
 *
 * Usage:
 *   OPENAI_API_KEY=... DEEPGRAM_API_KEY=... CARTESIA_API_KEY=... \
 *   LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
 *   npx tsx examples/basic-call.ts
 */

import { createCallOrchestrator, loadBackchannelClips, auroraPersona, formatUserDateTime } from '@mimic/engine'
import { createVoiceAgent } from '@mimic/transport-livekit'

const roomName = `mimic-demo-${Date.now()}`

const backchannelClips = await loadBackchannelClips(auroraPersona.ttsVoiceId)

const orchestrator = await createCallOrchestrator({
	persona: auroraPersona,
	systemPrompt: `You are Aurora, a friendly AI assistant on a phone call.
You help callers with general questions. Keep your responses short and conversational.
Use contractions, vary your sentence starters, and sound natural.`,
	userFirstName: 'Caller',
	buildOpeningBlock: () => `<context>\nnow: ${formatUserDateTime()}\n</context>`,
	buildTurnControlBlock: (ctx) => {
		const parts = [`<context>`, `now: ${formatUserDateTime(ctx.userTimezone)}`]
		if (ctx.recipient?.firstName) parts.push(`callerFirstName: ${ctx.recipient.firstName}`)
		parts.push('</context>')
		return parts.join('\n')
	},
	onTurnCommitted: (turn) => {
		console.log(`[caller] ${turn.userTranscript}`)
		console.log(`[agent] ${turn.assistantResponse}`)
	},
	onBackchannel: (token) => {
		agent.playBackchannelClip(token)
	},
})

const agent = await createVoiceAgent({
	roomName,
	identity: 'mimic-agent',
	logPrefix: 'demo',
	livekitUrl: process.env.LIVEKIT_URL!,
	livekitApiKey: process.env.LIVEKIT_API_KEY!,
	livekitApiSecret: process.env.LIVEKIT_API_SECRET!,
	orchestrator,
	backchannelClips,
	async connectServices() {
		await orchestrator.connectServices()
	},
	async onSessionEnd(result) {
		if (result) {
			console.log(`\nCall ended after ${result.durationSeconds}s, ${result.turnCount} turns`)
		}
		process.exit(0)
	},
})

console.log(`Waiting for caller to join room: ${roomName}`)
await agent.sessionComplete
