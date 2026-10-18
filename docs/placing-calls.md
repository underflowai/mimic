# Placing calls with the Mimic SDK

## Setup

Install the SDK and Zod:

```bash
npm install @underflowai/mimic zod
```

Set your API key:

```bash
export MIMIC_API_KEY=mk_live_...
```

## Basic call

The simplest call — just a phone number and a goal:

```typescript
import { Mimic } from '@underflowai/mimic'

const mimic = new Mimic(process.env.MIMIC_API_KEY!)

const call = mimic.call({
	to: '+15551234567',
	goal: 'Say hello and ask how their day is going',
})

const result = await call.result
console.log(result.status) // 'completed' or 'failed'
```

## Adding context

Tell the agent what it needs to know. Write it like you'd brief a human:

```typescript
const call = mimic.call({
	to: '+15551234567',
	goal: 'Confirm the appointment for tomorrow at 2pm',
	userTimezone: 'America/New_York',
	context: `You're calling on behalf of Greenwood Medical. We require
  24-hour cancellation notice. If they need to reschedule, collect their
  preferred date and time for the office to review. Dr. Smith is out on Fridays.`,
})
```

## Per-call data

Pass structured data about the person or situation. The agent knows
what fields exist and walks through them naturally:

```typescript
const call = mimic.call({
	to: '+15551234567',
	goal: 'Confirm the appointment',
	context: 'You work at Greenwood Medical.',
	data: {
		appointmentDate: 'Thursday May 16',
		appointmentTime: '2:00 PM',
		doctorName: 'Dr. Smith',
	},
	recipient: {
		firstName: 'Jane',
		lastName: 'Smith',
	},
})
```

`data`, `extract`, and `recipient` belong to the call, not the prompt. The
prompt is compiled once per distinct goal, context, tools, voice, and
AI-disclosure setting; these per-call details are appended to it at runtime
(`data` as "Details for this call", `extract` as what to find out, the
recipient's name in each turn's context). Fifty calls with fifty different
values compile once, and asking for different fields back never recompiles.

Set `userTimezone` to the caller's IANA timezone (for example,
`America/New_York`) when you know it. If you don't, Mimic guesses from the
phone number's area code, tells the agent the guess is unconfirmed, and the
agent confirms it lightly the first time a specific time matters ("that's
Eastern for you, right?"). Toll-free and other non-geographic numbers get no
guess, and the agent asks instead.

## Tools

Give the agent functions it can call during the conversation. Define
them with Zod — the types flow into your handler automatically:

```typescript
import { z } from 'zod'
import { Mimic, tool } from '@underflowai/mimic'

const mimic = new Mimic(process.env.MIMIC_API_KEY!)

const checkCalendar = tool({
	kind: 'read',
	description: 'Check available calendar slots',
	parameters: z.object({
		date: z.string().describe('The date to check'),
	}),
	run: async ({ date }) => {
		// Your existing code — runs locally in your process
		const slots = await myCalendarAPI.getSlots(date)
		return JSON.stringify(slots)
	},
})

const bookAppointment = tool({
	kind: 'write',
	description: 'Book an appointment',
	parameters: z.object({
		time: z.string().describe('The time slot'),
		email: z.string().email().describe('Patient email'),
	}),
	run: async ({ time, email }) => {
		await myCalendarAPI.book(time, email)
		return `Booked ${time} for ${email}`
	},
})

const call = mimic.call({
	to: '+15551234567',
	goal: 'Book an appointment for the caller',
	tools: { checkCalendar, bookAppointment },
})
```

Use `kind: 'write'` for actions such as booking, updating a record, or sending
a message; the agent waits for the caller's explicit go-ahead before running a
write. An omitted kind is `read`: the tool runs as soon as the caller's request
and its arguments are clear. MCP tools are reads only when the server marks
them `readOnlyHint: true`.

Tools execute locally in your process. Tool arguments and returned results
are sent through Mimic so the agent can use them; keep secrets inside your
handler rather than returning them.

## MCP tools

If you already have tools exposed via an MCP server, skip the
wrapping entirely:

```typescript
const tools = await mimic.mcp('http://localhost:3000/mcp')

const call = mimic.call({
	to: '+15551234567',
	goal: 'Book an appointment',
	tools,
})
```

You can mix MCP tools with custom tools:

```typescript
const mcpTools = await mimic.mcp('http://localhost:3000/mcp')

const call = mimic.call({
	to: '+15551234567',
	goal: 'Book an appointment',
	tools: { ...mcpTools, myCustomTool },
})
```

## Extracting data

Use a Zod schema to describe the values to extract from the call.
Known booleans come back as `true` or `false`, not strings. Every field
can also be `null` when the call did not establish its value, including
required or nonnullable schema fields. Unknown is different from false;
optional fields are returned as null when missing.

```typescript
import { z } from 'zod'

const call = mimic.call({
	to: '+15551234567',
	goal: 'Confirm the appointment',
	extract: z.object({
		confirmed: z.boolean().describe('whether the appointment was confirmed'),
		notes: z.string().nullable().describe('any notes from the conversation'),
		rescheduleDate: z.string().nullable().describe('new date if rescheduled'),
	}),
})

const result = await call.result
if (result.status === 'completed') {
	result.data.confirmed // boolean | null
	result.data.notes // string | null
	result.data.rescheduleDate // string | null
}
```

## Streaming events

Listen to the call in real-time:

```typescript
// Typed event handlers
call.on('speech', ({ role, text }) => {
	console.log(`[${role}] ${text}`)
})

call.on('tool_call', ({ name, args }) => {
	console.log(`Calling ${name} with`, args)
})

call.on('tool_result', ({ name, result }) => {
	console.log(`${name} returned: ${result}`)
})

call.on('done', ({ goalAchieved, goalAchievedReason }) => {
	console.log(`Goal achieved: ${goalAchieved} — ${goalAchievedReason}`)
})

call.on('error', ({ message }) => {
	console.error(`Error: ${message}`)
})
```

Or use async iteration:

```typescript
for await (const event of call) {
	switch (event.type) {
		case 'speech':
			console.log(`[${event.role}] ${event.text}`)
			break
		case 'tool_call':
			console.log(`Calling ${event.name}`)
			break
		case 'done':
			console.log(`Done: ${event.goalAchieved}`)
			break
	}
}
```

## Web calls

A call does not have to be dialed. With `channel: 'web'` nobody is called;
instead the API returns what a browser needs to join the agent's room, and
the conversation starts when the visitor connects.

```typescript
const call = mimic.call({
	channel: 'web',
	goal: 'Welcome the visitor and help them find the right plan',
	recipient: { firstName: 'Jane' }, // optional; names the browser participant
})

// Resolves as soon as the call is created, before anyone has joined.
const join = await call.web // { url, token } for web calls, null for phone calls
```

`join.url` is the LiveKit server and `join.token` is a one-hour token that can
only join this call's room: it cannot create rooms, list participants, or join
anything else, so it is safe to hand to the browser. Mint it on your server
(where your `mk_` key lives) and pass it down, then connect with
[`livekit-client`](https://www.npmjs.com/package/livekit-client):

```typescript
import { Room, RoomEvent, Track } from 'livekit-client'

const room = new Room()
room.on(RoomEvent.TrackSubscribed, (track) => {
	if (track.kind === Track.Kind.Audio) track.attach() // plays the agent
})
await room.connect(join.url, join.token)
await room.localParticipant.setMicrophoneEnabled(true)
// ...
await room.disconnect() // ends the call
```

How web calls differ from phone calls:

- `to` is omitted; `channel` must be `'web'`. Everything else in
  `CallOptions` applies, and `result`, events, tools and `extract` behave the
  same way.
- The agent waits up to two minutes for someone to join. If nobody does, the
  call ends `failed` with the message `No one joined the call within 120 seconds`.
- The call ends when the visitor disconnects. A page reload is a disconnect,
  so a single-page join flow is the right shape.
- `ambience` defaults to `false` for web calls (there is no phone line to
  make plausible), and `userTimezone` is not inferred since there is no
  number to infer it from. Pass it if the agent needs to talk about times.
- Replaying a request with the same `idempotencyKey` returns a fresh token
  for the same call while it can still be joined.

`GET /api/v1/calls/:id` reports `channel` for every call so you can tell the
two apart later.

## Cancelling a call

```typescript
const call = mimic.call({ to: '...', goal: '...' })

// Cancel after 60 seconds
setTimeout(() => call.cancel(), 60_000)

const result = await call.result
// result will reject with MimicError('Call cancelled')
```

Cancellation propagates to the server — the call is marked as cancelled,
queued jobs are removed, and any in-progress call is terminated.

## Owning the prompt

`mimic.call({ goal })` compiles a prompt behind the scenes and caches it.
When you want to read that prompt, edit it, or check it into your repo, make
compilation a separate step:

```typescript
const prompt = await mimic.compile({
	goal: 'Confirm the appointment and note anything the office should know',
	context: 'You work at Greenwood Medical. 24-hour cancellation notice.',
	tools: { checkCalendar }, // only names, descriptions, and parameters are sent
	voice: 'female',
})
// prompt = { goal, systemPrompt, turnControlBlock, agentName }

const call = mimic.call({
	to: '+15551234567',
	prompt,
	data: { appointmentTime: '2:00 PM' },
	extract: z.object({ confirmed: z.boolean().describe('whether they confirmed') }),
})
```

`compile()` stores nothing; the returned prompt is yours. A call made with
`prompt` uses `systemPrompt` verbatim (max 48,000 characters) and never
recompiles, whatever `data`, `extract`, or `recipient` it carries. The same
goes for a prompt you wrote yourself: a personal agent with its own identity,
a branded assistant with a maintained voice. `prompt.goal` is still used by
the result extractor as its rubric for `goalAchieved`. `context` is not woven
into an owned prompt, so put required background in `systemPrompt`.

The earlier `persona: { systemPrompt, agentName }` option with a top-level
`goal` is still accepted and behaves the same way.

## Completion webhook

```typescript
mimic.call({
	to: '+15551234567',
	goal: '...',
	webhook: 'https://example.com/mimic/completed', // receives a call.completed event
})
```

## Options reference

```typescript
mimic.call({
  // The agent: one of
  goal: 'What the agent should do',   // compiled into a prompt once, then cached
  prompt,                             // from mimic.compile() or hand-written (see above)

  // Who to call
  to: '+15551234567',           // E.164 phone number; omit for web calls
  channel: 'phone',             // 'phone' (default) or 'web' (see above)

  // Knowledge
  context: 'Background info as prose...',
  data: { field: 'value' },     // Structured per-call data

  // Who you're calling
  recipient: { firstName: 'Jane', lastName: 'Smith', email: 'jane@...' },

  // Tools
  tools: { checkCalendar },     // Zod tool() definitions or MCP tools

  // Extraction
  extract: z.object({ ... }),   // Zod schema for typed results

  // Voice
  voice: 'female',              // 'female' (Aurora) or 'male' (Arlo)
  userTimezone: 'America/New_York', // Caller timezone; guessed from the area code and confirmed if omitted
  aiDisclosure: true,           // Proactively disclose AI status

  // Audio
  ambience: true,               // Office background noise

  // Completion webhook
  webhook: 'https://example.com/mimic/completed',

  // Timeouts
  timeoutMs: 300_000,           // Max wait time (default 5 min)
  toolTimeoutMs: 30_000,        // Per-tool timeout (default 30s)

  // Deduplication
  idempotencyKey: 'unique-key', // Prevent duplicate calls
})
```

`aiDisclosure` controls the AI introduction. Configure recording notice and
consent separately for the actual recording workflow; this flag does not
establish recording status or caller consent.

## Running the example

From the repo root:

```bash
MIMIC_API_KEY=mk_live_... npx tsx examples/sdk-call.ts
```

For a web call, `examples/web-call.ts` creates the call and serves a page
that joins it:

```bash
MIMIC_API_KEY=mk_live_... MIMIC_BASE_URL=https://... npx tsx examples/web-call.ts
# then open http://localhost:8787
```
