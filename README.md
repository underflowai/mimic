# Mimic

Make AI phone calls with a few lines of code.

```typescript
import { Mimic } from '@mimic/sdk'

const mimic = new Mimic('mk_...')

const call = mimic.call({
  to: '+15551234567',
  goal: 'Confirm the appointment for tomorrow at 2pm with Dr. Smith',
  context: `You're calling on behalf of Greenwood Medical. We require
  24-hour cancellation notice. Dr. Smith is out on Fridays.`,
})

const result = await call.result
console.log(result.status) // 'completed' or 'failed'
```

Give it a phone number and a goal. Mimic handles the rest — dialing, conversation, interruptions, and structured results.

## How it works

```
Your code → Mimic API → LiveKit SIP → Phone call
                       → Deepgram Flux (listen)
                       → OpenAI / Anthropic (think)
                       → Cartesia Sonic (speak)
```

The SDK sends a goal to the API server. The server compiles it into a voice agent prompt, dials the phone number via SIP, runs a real-time voice engine, and returns structured results when the call ends. Tool functions execute locally in your process — your secrets never leave your machine.

## Quick start

```bash
npm install @mimic/sdk zod
```

```typescript
import { Mimic } from '@mimic/sdk'

const mimic = new Mimic(process.env.MIMIC_API_KEY!)

const call = mimic.call({
  to: '+15551234567',
  goal: 'Say hello and ask how their day is going',
})

const result = await call.result
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
  recipient: { firstName: 'Jane', lastName: 'Smith' },
})
```

## Tools

Give the agent functions it can call during the conversation:

```typescript
import { z } from 'zod'
import { Mimic, tool } from '@mimic/sdk'

const mimic = new Mimic(process.env.MIMIC_API_KEY!)

const checkCalendar = tool({
  description: 'Check available calendar slots',
  parameters: z.object({ date: z.string().describe('The date to check') }),
  run: async ({ date }) => myCalendarAPI.getSlots(date),
})

const call = mimic.call({
  to: '+15551234567',
  goal: 'Book an appointment for the caller',
  tools: { checkCalendar },
})
```

Tools execute locally in your process. Or connect to an MCP server:

```typescript
const tools = await mimic.mcp('http://localhost:3000/mcp')
mimic.call({ to: '+15551234567', goal: 'Book an appointment', tools })
```

## Extracting data

Use a Zod schema to get typed results from the call:

```typescript
import { z } from 'zod'

const call = mimic.call({
  to: '+15551234567',
  goal: 'Confirm the appointment',
  extract: z.object({
    confirmed: z.boolean().describe('whether the appointment was confirmed'),
    notes: z.string().nullable().describe('any notes from the conversation'),
  }),
})

const result = await call.result
if (result.status === 'completed') {
  result.data.confirmed  // boolean
  result.data.notes      // string | null
}
```

## Streaming events

```typescript
call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))
call.on('tool_call', ({ name, args }) => console.log(`calling ${name}`))
call.on('done', ({ goalAchieved }) => console.log(goalAchieved))

// Or async iteration
for await (const event of call) { ... }

// Or just get the result
const result = await call.result
```

## Options reference

```typescript
mimic.call({
  // Required
  to: '+15551234567',           // E.164 phone number
  goal: 'What the agent should do',

  // Knowledge
  context: 'Background info...',
  data: { field: 'value' },     // Structured per-call data

  // Who you're calling
  recipient: { firstName: 'Jane', lastName: 'Smith' },

  // Tools
  tools: { checkCalendar },     // tool() definitions or MCP tools

  // Extraction
  extract: z.object({ ... }),   // Zod schema for typed results

  // Voice
  voice: 'female',              // 'female' (Aurora) or 'male' (Arlo)
  aiDisclosure: true,           // Disclose AI status + recording
  ambience: true,               // Office background noise

  // Timeouts
  timeoutMs: 300_000,           // Max wait (default 5 min)
  toolTimeoutMs: 30_000,        // Per-tool timeout (default 30s)

  // Deduplication
  idempotencyKey: 'unique-key',
})
```

## Packages

| Package | What it does |
|---|---|
| `packages/sdk` | Client SDK — `tool()`, streaming, typed results |
| `packages/engine` | Voice engine — ASR, LLM, TTS, interrupts, speculation, backchannel |
| `packages/server` | API server — Hono, Postgres, SIP dialing, result extraction |
| `packages/transport-livekit` | LiveKit adapter — rooms, audio I/O, noise cancellation |

## Self-hosting

### Prerequisites

- Node.js 22+
- PostgreSQL
- Redis
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
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://...
```

### Run locally

```bash
pnpm install
cd packages/server
pnpm db:migrate
npx tsx src/scripts/create-key.ts
pnpm start
```

### Deploy

```bash
# Railway
railway up

# Docker
docker build -t mimic .
docker run -p 3000:3000 --env-file .env mimic
```

The server includes an in-process call worker by default. For dedicated worker topology, set `MIMIC_DISABLE_IN_PROCESS_WORKER=1` on the API container and run the worker separately:

```bash
docker run --env-file .env mimic node packages/server/build/worker.js
```

## Engine

The voice engine handles real-time conversation with sub-second latency:

- **Deepgram Flux** — streaming ASR with eager end-of-turn detection
- **OpenAI / Anthropic** — LLM director, streaming token-by-token
- **Cartesia Sonic** — low-latency TTS with context continuations
- **Eager speculation** — pre-generates responses before the caller finishes (~460ms median first audio)
- **Soft-pause interrupts** — yields to the caller, resumes if they stop
- **Backchannel** — "mm-hmm", "right", "yeah" during caller speech
- **Tool orchestration** — background intent detection + execution without blocking conversation

See [packages/engine/src/README.md](packages/engine/src/README.md) for architecture docs.

## License

MIT
