import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import { Mimic } from '../packages/sdk/src/index.js'

// A web call: nobody is dialed. The server creates the call with your API key,
// hands the browser a room-scoped join token, and the browser talks to the
// agent over WebRTC.
//
// Usage: MIMIC_API_KEY=mk_live_… MIMIC_BASE_URL=https://… npx tsx examples/web-call.ts
// then open http://localhost:8787 and click "Start".
const apiKey = process.env.MIMIC_API_KEY
const baseUrl = process.env.MIMIC_BASE_URL
const port = Number(process.env.PORT ?? 8787)
if (!apiKey || !baseUrl) {
	console.error('Set MIMIC_API_KEY and MIMIC_BASE_URL.')
	process.exit(1)
}

const mimic = new Mimic({ apiKey, baseUrl })

const page = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mimic web call</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  button { font: inherit; padding: 0.6rem 1.2rem; border-radius: 0.5rem; border: 1px solid #1a1a1a; background: #1a1a1a; color: #fff; cursor: pointer; }
  button[disabled] { opacity: 0.5; cursor: default; }
  button.secondary { background: #fff; color: #1a1a1a; }
  #status { margin: 1rem 0; color: #555; }
  #transcript p { margin: 0.25rem 0; }
  #transcript .agent { color: #0b5fff; }
</style>
</head>
<body>
<h1>Talk to Aurora</h1>
<p>Click Start, allow the microphone, and say hello. Leaving the page ends the call.</p>
<button id="start">Start</button>
<button id="stop" class="secondary" disabled>Hang up</button>
<p id="status">Idle</p>
<div id="transcript"></div>
<script type="module">
  import { Room, RoomEvent, Track } from 'https://esm.sh/livekit-client@2'

  const status = document.getElementById('status')
  const transcript = document.getElementById('transcript')
  const start = document.getElementById('start')
  const stop = document.getElementById('stop')
  let room = null
  let events = null

  start.onclick = async () => {
    start.disabled = true
    status.textContent = 'Creating call…'
    try {
      const res = await fetch('/join', { method: 'POST' })
      if (!res.ok) throw new Error(await res.text())
      const { sessionId, url, token } = await res.json()

      room = new Room()
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) document.body.appendChild(track.attach())
      })
      room.on(RoomEvent.Disconnected, () => {
        status.textContent = 'Call ended'
        stop.disabled = true
        start.disabled = false
      })

      status.textContent = 'Connecting…'
      await room.connect(url, token)
      await room.startAudio() // allowed: we are inside a click handler
      stop.disabled = false
      try {
        await room.localParticipant.setMicrophoneEnabled(true)
        status.textContent = 'Connected. Say hello.'
      } catch (err) {
        status.textContent = 'Connected, but the microphone is off: ' + (err?.message ?? err)
      }

      events = new EventSource('/events/' + sessionId)
      events.onmessage = (e) => {
        const ev = JSON.parse(e.data)
        if (ev.type === 'speech') {
          const p = document.createElement('p')
          p.className = ev.role
          p.textContent = (ev.role === 'agent' ? 'Aurora: ' : 'You: ') + ev.text
          transcript.appendChild(p)
        } else if (ev.type === 'done' || ev.type === 'error') {
          status.textContent = ev.type === 'done' ? 'Call ended' : 'Call ended: ' + ev.message
          events.close()
        }
      }
    } catch (err) {
      status.textContent = 'Failed: ' + (err?.message ?? err)
      start.disabled = false
    }
  }

  stop.onclick = async () => {
    stop.disabled = true
    events?.close()
    await room?.disconnect()
  }
</script>
</body>
</html>`

type Listener = (event: unknown) => void
const feeds = new Map<string, { history: unknown[]; listeners: Set<Listener> }>()

function publish(callId: string, event: unknown) {
	const feed = feeds.get(callId)
	if (!feed) return
	feed.history.push(event)
	for (const listener of feed.listeners) listener(event)
}

createServer(async (req, res) => {
	if (req.method === 'GET' && req.url === '/') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page)
		return
	}

	if (req.method === 'POST' && req.url === '/join') {
		const call = mimic.call({
			channel: 'web',
			goal: `You are Aurora, Underflow's voice assistant. Have a brief conversation that demonstrates the voice experience and answers the visitor's questions about it. Let their questions guide the discussion, keep answers short, and respect a goodbye immediately.`,
			context: `Underflow builds AI voice agents for business conversations. The visitor is talking to you from a web page, not a phone. No price list or integration catalog is supplied; say so rather than infer.`,
			recipient: { firstName: 'Visitor' },
			aiDisclosure: false,
			timeoutMs: 10 * 60_000,
		})

		const sessionId = randomUUID()
		feeds.set(sessionId, { history: [], listeners: new Set() })
		call.on('speech', (event) => {
			console.log(`[${event.role}] ${event.text}`)
			publish(sessionId, event)
		})
		call.on('done', (event) => {
			console.log(`Goal achieved: ${event.goalAchieved} — ${event.goalAchievedReason}`)
			publish(sessionId, event)
		})
		call.on('error', (event) => {
			console.error(`Error: ${event.message}`)
			publish(sessionId, event)
		})
		call.result.catch(() => {})

		try {
			const join = await call.web
			if (!join) throw new Error('Expected join details for a web call')
			res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessionId, ...join }))
		} catch (err) {
			feeds.delete(sessionId)
			res.writeHead(500, { 'content-type': 'text/plain' }).end(err instanceof Error ? err.message : String(err))
		}
		return
	}

	const events = req.url?.match(/^\/events\/([^/]+)$/)
	if (req.method === 'GET' && events) {
		const feed = feeds.get(events[1]!)
		if (!feed) {
			res.writeHead(404).end()
			return
		}
		res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
		const send: Listener = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
		for (const event of feed.history) send(event)
		feed.listeners.add(send)
		req.on('close', () => feed.listeners.delete(send))
		return
	}

	res.writeHead(404).end()
}).listen(port, () => {
	console.log(`Open http://localhost:${port}`)
})
