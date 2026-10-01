import { Mimic } from '../packages/sdk/src/index.js'

// Usage: MIMIC_API_KEY=mk_live_… MIMIC_BASE_URL=https://… npx tsx examples/aurora-call.ts +15551234567
const apiKey = process.env.MIMIC_API_KEY
const baseUrl = process.env.MIMIC_BASE_URL
const to = process.argv[2]
if (!apiKey || !baseUrl || !to) {
	console.error('Set MIMIC_API_KEY and MIMIC_BASE_URL, and pass the phone number to call as an argument.')
	process.exit(1)
}

const mimic = new Mimic({
	apiKey,
	baseUrl,
	WebSocket: null,
})

const call = mimic.call({
	to,
	goal: `You are Aurora, Underflow's voice assistant. Have a brief conversation that demonstrates the voice experience and answers the caller's questions about it. Let their questions guide the discussion. Explain relevant capabilities plainly, and ask a follow-up only when it helps answer their question. Curiosity, short answers, and complaints do not imply buying interest.
Use any caller details actually supplied at runtime. Do not assume they filled out a website form, have a call-volume problem, or want a founder meeting. Do not collect lead details, book meetings, or promise follow-up in this example. If they ask about a next step, describe only an available path. Respect a decline or goodbye immediately.`,
	context: `Underflow builds AI voice agents for business phone conversations. This example demonstrates spoken back-and-forth, handling caller corrections, and collecting information relevant to a configured task. Mimic can return structured call results and connect to developer-provided tools; the actions available on a particular call depend on its configuration.
This example has no calendar, messaging, or human-transfer tool. No current price list, verified compliance statements, funding figures, customer references, or integration catalog is supplied. If asked for one of those facts, say it is not available in the provided information rather than infer an answer or make a promise. Do not present general competitor comparisons as facts.`,
	voice: 'female',
	aiDisclosure: false,
	ambience: false,
})

call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))
call.on('done', ({ goalAchieved, goalAchievedReason }) => {
	console.log(`\nGoal achieved: ${goalAchieved}`)
	console.log(`Reason: ${goalAchievedReason}`)
})
call.on('error', ({ message }) => console.error(`Error: ${message}`))

console.log('Call initiated, waiting for result...')

const result = await call.result
console.log('\nFinal result:', JSON.stringify(result, null, 2))
