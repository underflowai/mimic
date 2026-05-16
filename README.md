# Mimic

Make AI phone calls with a few lines of code. Tools run locally — your secrets never leave your machine.

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

const call = mimic.call<{ confirmed: boolean }>({
  to: '+15551234567',
  goal: 'Confirm the appointment for tomorrow at 2pm',
  tools: { checkCalendar },
  extract: { confirmed: 'whether the appointment was confirmed' },
})

call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))

const result = await call.result
if (result.status === 'completed') {
  console.log(result.data.confirmed) // boolean
}
```

## How it works

```
SDK (your code) → API server (Railway) → LiveKit SIP → Phone call
                                        → Deepgram (listen)
                                        → LLM (think)
                                        → Cartesia (speak)
```

The SDK opens a WebSocket to the server. The server dials the phone number via SIP, runs the voice engine, and streams events back in real-time. Your tool functions execute locally in your process — the server invokes them over the WebSocket.

## Packages

| Package | What it does |
|---|---|
| `packages/sdk` | Client SDK — `Mimic` class, `tool()` helper, streaming, typed results |
| `packages/engine` | Voice engine — Deepgram Flux ASR, LLM director, Cartesia TTS, interrupt handling, eager speculation, backchannel |
| `packages/server` | API server — Hono routes, Postgres, SIP dialing, call lifecycle, result extraction |
| `packages/transport-livekit` | LiveKit adapter — room lifecycle, audio I/O, noise cancellation, ambience |

## SDK

### Install

```bash
npm install @mimic/sdk zod
```

### Define tools with Zod

Schema is the single source of truth — types flow into your handler automatically.

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
const call = mimic.call<{ confirmed: boolean; notes: string }>({
  to: '+15551234567',
  goal: 'Confirm the appointment for tomorrow at 2pm',
  tools: { checkCalendar, reschedule },
  voice: 'female',
  context: { patientName: 'Jane Doe', doctorName: 'Dr. Smith' },
  extract: {
    confirmed: 'whether the appointment was confirmed',
    notes: 'any notes from the conversation',
  },
})
```

### Stream events

```typescript
// Option A: async iteration
for await (const event of call) {
  switch (event.type) {
    case 'speech': console.log(`[${event.role}] ${event.text}`); break
    case 'tool_call': console.log(`calling ${event.name}`); break
    case 'tool_result': console.log(`${event.name}: ${event.result}`); break
    case 'done': console.log(`goal: ${event.goalAchieved}`); break
  }
}

// Option B: typed event handlers
call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))
call.on('done', ({ goalAchieved }) => console.log(goalAchieved))

// Option C: just get the result
const result = await call.result
```

### Typed results

```typescript
const result = await call.result

if (result.status === 'completed') {
  result.data.confirmed  // boolean — typed from the generic
  result.transcript      // TranscriptEntry[]
  result.duration        // number (seconds)
} else {
  result.error           // string
}
```

## Self-hosting

### Prerequisites

- Node.js 22+
- PostgreSQL
- [LiveKit Cloud](https://cloud.livekit.io) account with SIP trunk
- API keys: OpenAI, Deepgram, Cartesia

### Environment variables

```bash
# Required
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
npx drizzle-kit push              # create DB tables
npx tsx src/scripts/create-key.ts  # generate an API key
pnpm start                         # start the server
```

### Deploy

The repo includes a Dockerfile. Deploy to any container platform:

```bash
# Railway
railway up

# Fly.io
fly deploy

# Docker
docker build -t mimic .
docker run -p 3000:3000 --env-file .env mimic
```

## Engine architecture

The voice engine handles real-time conversation with sub-second latency:

- **Deepgram Flux** — Streaming ASR with eager end-of-turn detection
- **LLM Director** — OpenAI or Anthropic, streaming token-by-token
- **Cartesia Sonic** — Low-latency TTS with SSML support
- **Eager speculation** — Pre-generates responses before the caller finishes speaking
- **Soft-pause interrupts** — Yields to the caller mid-sentence, resumes if they stop
- **Backchannel** — "mm-hmm", "right", "yeah" while the caller is speaking

See [packages/engine/src/README.md](packages/engine/src/README.md) for the full architecture docs.

## License

MIT
