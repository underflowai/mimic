# Mimic

Make AI phone calls with a few lines of code.

```typescript
import { z } from 'zod'
import { Mimic, tool } from '@mimic/sdk'

const mimic = new Mimic('mk_...')

const checkCalendar = tool({
  description: 'Check available calendar slots',
  parameters: z.object({
    date: z.string().describe('The date to check'),
  }),
  run: async ({ date }) => calendar.getSlots(date),
})

const call = mimic.call({
  to: '+15551234567',
  goal: 'Confirm the appointment for tomorrow at 2pm',
  tools: { checkCalendar },
  extract: z.object({
    confirmed: z.boolean().describe('whether the appointment was confirmed'),
    notes: z.string().nullable().describe('any notes from the conversation'),
  }),
})

call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))

const result = await call.result
if (result.status === 'completed') {
  result.data.confirmed  // boolean — enforced, not guessed
  result.data.notes      // string | null
}
```

## How it works

```
SDK (your code) → API server (Railway) → LiveKit SIP → Phone call
                                        → Deepgram (listen)
                                        → LLM (think)
                                        → Cartesia (speak)
```

The SDK opens a WebSocket to the server. The server dials the phone number via SIP, runs the voice engine, and streams events back in real-time. Your tool functions execute locally in your process.

## Packages

| Package | What it does |
|---|---|
| `packages/sdk` | Client SDK — `tool()`, streaming, typed results |
| `packages/engine` | Voice engine — ASR, LLM, TTS, interrupts, speculation, backchannel |
| `packages/server` | API server — Hono, Postgres, SIP dialing, result extraction |
| `packages/transport-livekit` | LiveKit adapter — rooms, audio I/O, noise cancellation |

## SDK

### Install

```bash
npm install @mimic/sdk zod
```

### Define tools

Zod is the single source of truth. Types flow into your handler automatically.

```typescript
import { z } from 'zod'
import { tool } from '@mimic/sdk'

const reschedule = tool({
  description: 'Reschedule an appointment',
  parameters: z.object({
    newDate: z.string().describe('The new date'),
    newTime: z.string().describe('The new time'),
  }),
  run: async ({ newDate, newTime }) => {
    await calendar.reschedule(newDate, newTime)
    return `Rescheduled to ${newDate} at ${newTime}`
  },
})
```

### Make a call

```typescript
const call = mimic.call({
  to: '+15551234567',
  goal: 'Confirm the appointment for tomorrow at 2pm',

  // Background knowledge (baked into the agent's prompt)
  context: `You're calling on behalf of Greenwood Medical. We require
  24-hour cancellation notice. Dr. Smith is out on Fridays.`,

  // Per-call structured data (field names compiled, values injected at runtime)
  data: {
    appointmentDate: 'Thursday May 16',
    appointmentTime: '2:00 PM',
    doctorName: 'Dr. Smith',
  },

  // Who you're calling (injected per-turn, not compiled into prompt)
  recipient: { firstName: 'Jane', lastName: 'Smith' },

  // Tools the agent can use
  tools: { checkCalendar, reschedule },

  // What to extract — Zod schema enforces types
  extract: z.object({
    confirmed: z.boolean().describe('whether confirmed'),
    notes: z.string().nullable().describe('any notes'),
  }),

  voice: 'female',          // Aurora (female) or Arlo (male)
  aiDisclosure: true,        // disclose AI status + recording
  ambience: true,            // office background noise
})
```

### Stream events

```typescript
// Typed event handlers
call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))
call.on('tool_call', ({ name, args }) => console.log(`calling ${name}`))
call.on('done', ({ goalAchieved }) => console.log(goalAchieved))

// Or async iteration
for await (const event of call) { ... }

// Or just get the result
const result = await call.result
```

### Typed results

```typescript
const result = await call.result

if (result.status === 'completed') {
  result.data.confirmed  // boolean — from Zod schema
  result.transcript      // TranscriptEntry[]
  result.duration        // number (seconds)
} else {
  result.error           // string
}
```

### Cancel a call

```typescript
call.cancel()
```

### Prompt caching

Same `goal + context + tools + data keys` → instant. The LLM compiles the prompt once (~30s) and reuses it for every subsequent call with the same config. Different recipients, different data values, different phone numbers all reuse the cached prompt.

## Self-hosting

### Prerequisites

- Node.js 22+
- PostgreSQL
- [LiveKit Cloud](https://cloud.livekit.io) account with SIP trunk
- API keys: OpenAI, Deepgram, Cartesia

### Environment variables

```bash
OPENAI_API_KEY=sk-...
DEEPGRAM_API_KEY=...
CARTESIA_API_KEY=sk_car_...
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_SIP_OUTBOUND_TRUNK_ID=ST_...
DATABASE_URL=postgresql://...
```

### Run locally

```bash
pnpm install
cd packages/server
npx drizzle-kit push
npx tsx src/scripts/create-key.ts
pnpm start
```

### Deploy

```bash
# Railway (includes Dockerfile)
railway up

# Docker
docker build -t mimic .
docker run -p 3000:3000 --env-file .env mimic
```

## Engine

The voice engine handles real-time conversation with sub-second latency:

- **Deepgram Flux** — Streaming ASR with eager end-of-turn detection
- **LLM Director** — OpenAI or Anthropic, streaming token-by-token
- **Cartesia Sonic** — Low-latency TTS with SSML and extended fillers
- **Eager speculation** — Pre-generates responses before the caller finishes
- **Soft-pause interrupts** — Yields to the caller, resumes if they stop
- **Backchannel** — "mm-hmm", "right", "yeah" during caller speech

See [packages/engine/src/README.md](packages/engine/src/README.md) for architecture docs.

## License

MIT
