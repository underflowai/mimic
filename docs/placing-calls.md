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

`data` names and values are supplied to the prompt compiler. The compiled
prompt cache includes that data and the recipient, so another person's
values do not reuse a prompt containing the previous person's details.

`recipient` is also available in each turn's runtime context. Set
`userTimezone` to the caller's IANA timezone (for example, `America/New_York`)
to resolve “today” and “tomorrow” in their local time. Timezone is stored
per call and does not require a separate compiled prompt.

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

Use `kind: 'read'` for lookups and `kind: 'write'` for actions such as booking,
updating a record, or sending a message. An omitted kind defaults to `write`;
only tools explicitly marked read are eligible for speculative execution.

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

## Persona mode

By default Mimic compiles your `goal` and `context` into a voice-agent
prompt. If your caller already has an identity of its own — a personal
agent phoning its user, a branded assistant with a maintained voice — pass
the system prompt directly and skip compilation:

```typescript
const call = mimic.call({
	to: '+15551234567',
	goal: 'Check in on how the morning went and note anything that needs follow-up',
	persona: {
		systemPrompt: ripplePrompt, // your full agent prompt, used verbatim
		agentName: 'Ripple',
	},
})
```

`goal` is still required: the result extractor uses it as its rubric for
`goalAchieved` and `extract`. `context` and `data` are stored but not woven
into the persona prompt, so put required background in `systemPrompt`
(max 48,000 characters). `recipient` and `userTimezone` remain available in
runtime context. Calls with identical options reuse the same agent;
changing the persona creates a distinct configuration.

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
  // Required
  to: '+15551234567',           // E.164 phone number
  goal: 'What the agent should do',

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
  userTimezone: 'America/New_York', // Caller timezone for relative dates/times
  aiDisclosure: true,           // Proactively disclose AI status

  // Audio
  ambience: true,               // Office background noise

  // Persona mode (skip goal compilation; see above)
  persona: { systemPrompt: '...', agentName: 'Ripple' },

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
