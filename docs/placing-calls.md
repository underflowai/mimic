# Placing calls with the Mimic SDK

## Setup

Install the SDK and Zod:

```bash
npm install @mimic/sdk zod
```

Set your API key:

```bash
export MIMIC_API_KEY=mk_live_...
```

## Basic call

The simplest call — just a phone number and a goal:

```typescript
import { Mimic } from '@mimic/sdk'

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
  context: `You're calling on behalf of Greenwood Medical. We require
  24-hour cancellation notice. If they need to reschedule, offer the
  next available slot. Dr. Smith is out on Fridays.`,
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

`data` field names are compiled into the prompt (so the agent knows
what to discuss), but the values are injected at runtime. This means
you can reuse the same compiled prompt across different patients —
only the first call compiles (~30s), every subsequent call with the
same goal + context + data keys is instant.

`recipient` is injected per-turn so the agent can use their name
naturally. It never affects the compiled prompt.

## Tools

Give the agent functions it can call during the conversation. Define
them with Zod — the types flow into your handler automatically:

```typescript
import { z } from 'zod'
import { Mimic, tool } from '@mimic/sdk'

const mimic = new Mimic(process.env.MIMIC_API_KEY!)

const checkCalendar = tool({
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

Tools execute locally in your process. Your secrets and APIs never
leave your machine.

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

Use a Zod schema to extract typed, validated data from the call.
The types are enforced — booleans come back as `true`/`false`, not
`"true"`:

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
  result.data.confirmed     // boolean
  result.data.notes         // string | null
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
  aiDisclosure: true,           // Disclose AI status + recording

  // Audio
  ambience: true,               // Office background noise

  // Timeouts
  timeoutMs: 300_000,           // Max wait time (default 5 min)
  toolTimeoutMs: 30_000,        // Per-tool timeout (default 30s)

  // Deduplication
  idempotencyKey: 'unique-key', // Prevent duplicate calls
})
```

## Running the example

From the repo root:

```bash
MIMIC_API_KEY=mk_live_... npx tsx examples/sdk-call.ts
```
