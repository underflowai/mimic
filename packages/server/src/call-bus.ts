/**
 * Redis-backed call bus — event streaming and SDK tool bridging that works
 * across processes.
 *
 * The documented deployment runs the HTTP API and the call workers as
 * separate processes: the SDK's WebSocket lands on an API instance while the
 * call itself runs in a worker. Events published by the worker reach WS
 * subscribers on any API instance via Redis pub/sub, and tool invocations
 * from the worker are bridged to whichever process holds the SDK connection.
 *
 * Channels:
 * - `mimic:events:{callId}`      call lifecycle/speech events (JSON)
 * - `mimic:tool:req:{callId}`    tool invocation requests from the engine
 * - `mimic:tool:res:{callbackId}` tool results, one channel per invocation
 *
 * Keys:
 * - `mimic:tool:owner:{callId}`  connection id of the SDK connection that
 *   owns the tool channel (NX lock with TTL heartbeat, so a crashed API
 *   process frees the slot within `ownerTtlSeconds`).
 */

import { Redis } from 'ioredis'

import { childLogger } from './logger.js'

type EventCallback = (event: Record<string, unknown>) => void
export type ToolCallbackFn = (
	toolName: string,
	toolArgs: Record<string, unknown>,
	callbackId: string,
) => Promise<{ result: string } | { error: string }>

export interface ToolHandler {
	registered: boolean
	unregister: () => void
}

const eventsChannel = (callId: string) => `mimic:events:${callId}`
const toolRequestChannel = (callId: string) => `mimic:tool:req:${callId}`
const toolResponseChannel = (callbackId: string) => `mimic:tool:res:${callbackId}`
const toolOwnerKey = (callId: string) => `mimic:tool:owner:${callId}`

const ownerTtlSeconds = 90
const ownerRefreshMs = 30_000
/** Slightly above the API-side SDK callback timeout (30s) so the API's
 * more specific timeout error propagates instead of a generic bus timeout. */
const toolBridgeTimeoutMs = 35_000

const log = childLogger({ module: 'call-bus' })

// ---------------------------------------------------------------------------
// Connections (lazy — REDIS_URL is only required once the bus is used)
// ---------------------------------------------------------------------------

let _pub: Redis | null = null
let _sub: Redis | null = null

function redisUrl(): string {
	const url = process.env.REDIS_URL
	if (!url) throw new Error('REDIS_URL environment variable is required for the call bus')
	return url
}

/** Connection for regular commands and PUBLISH. */
function pub(): Redis {
	if (!_pub) {
		_pub = new Redis(redisUrl(), { maxRetriesPerRequest: null })
		_pub.on('error', (err) => log.error({ err: err.message }, 'call bus publisher error'))
	}
	return _pub
}

/** Dedicated connection in subscriber mode, shared by all subscriptions. */
function sub(): Redis {
	if (!_sub) {
		_sub = new Redis(redisUrl(), { maxRetriesPerRequest: null })
		_sub.on('error', (err) => log.error({ err: err.message }, 'call bus subscriber error'))
		_sub.on('message', (channel: string, message: string) => dispatch(channel, message))
	}
	return _sub
}

// ---------------------------------------------------------------------------
// Channel subscription bookkeeping
// ---------------------------------------------------------------------------

const channelListeners = new Map<string, Set<(message: string) => void>>()
const channelReady = new Map<string, Promise<void>>()

function dispatch(channel: string, message: string) {
	const listeners = channelListeners.get(channel)
	if (!listeners) return
	for (const listener of listeners) {
		try {
			listener(message)
		} catch (err) {
			log.error({ channel, err: err instanceof Error ? err.message : String(err) }, 'bus listener threw')
		}
	}
}

/**
 * Add a listener for a channel, subscribing on first use. Returns an
 * unsubscribe function and a promise that resolves once the server has
 * acknowledged the subscription (messages published before that can be
 * missed — await `ready` when the publish depends on it).
 */
function subscribeChannel(
	channel: string,
	listener: (message: string) => void,
): { unsubscribe: () => void; ready: Promise<void> } {
	let listeners = channelListeners.get(channel)
	if (!listeners) {
		listeners = new Set()
		channelListeners.set(channel, listeners)
		const ready = sub()
			.subscribe(channel)
			.then(() => undefined)
		channelReady.set(channel, ready)
		ready.catch((err) => log.error({ channel, err: err.message }, 'failed to subscribe'))
	}
	listeners.add(listener)
	const ready = channelReady.get(channel) ?? Promise.resolve()

	const unsubscribe = () => {
		const current = channelListeners.get(channel)
		if (!current) return
		current.delete(listener)
		if (current.size === 0) {
			channelListeners.delete(channel)
			channelReady.delete(channel)
			sub()
				.unsubscribe(channel)
				.catch((err) => log.error({ channel, err: err.message }, 'failed to unsubscribe'))
		}
	}
	return { unsubscribe, ready: ready.catch(() => undefined) }
}

// ---------------------------------------------------------------------------
// Call events
// ---------------------------------------------------------------------------

/** Publish a call event to all subscribers (any process). Fire-and-forget. */
export function publishCallEvent(callId: string, event: Record<string, unknown>) {
	pub()
		.publish(eventsChannel(callId), JSON.stringify(event))
		.catch((err) => log.error({ callId, err: err.message }, 'failed to publish call event'))
}

/** Subscribe to a call's event stream. Returns an unsubscribe function. */
export function subscribeToCall(callId: string, callback: EventCallback): () => void {
	const { unsubscribe } = subscribeChannel(eventsChannel(callId), (message) => {
		let event: Record<string, unknown>
		try {
			event = JSON.parse(message) as Record<string, unknown>
		} catch {
			return
		}
		callback(event)
	})
	return unsubscribe
}

// ---------------------------------------------------------------------------
// Tool bridge — SDK side (the process holding the WebSocket)
// ---------------------------------------------------------------------------

interface ToolRequestMessage {
	callbackId: string
	toolName: string
	toolArgs: Record<string, unknown>
}

/**
 * Register the SDK connection as this call's tool executor. Only one
 * connection may own a call's tool channel at a time (enforced across
 * processes with a Redis NX lock).
 */
export async function registerToolHandler(
	callId: string,
	handler: ToolCallbackFn,
	connectionId: string,
): Promise<ToolHandler> {
	const acquired = await pub().set(toolOwnerKey(callId), connectionId, 'EX', ownerTtlSeconds, 'NX')
	if (acquired !== 'OK') {
		const owner = await pub().get(toolOwnerKey(callId))
		if (owner !== connectionId) {
			return { registered: false, unregister: () => {} }
		}
	}

	const refresh = setInterval(() => {
		pub()
			.expire(toolOwnerKey(callId), ownerTtlSeconds)
			.catch((err) => log.error({ callId, err: err.message }, 'failed to refresh tool owner lock'))
	}, ownerRefreshMs)
	refresh.unref?.()

	const { unsubscribe, ready } = subscribeChannel(toolRequestChannel(callId), (message) => {
		let request: ToolRequestMessage
		try {
			request = JSON.parse(message) as ToolRequestMessage
		} catch {
			return
		}
		void (async () => {
			let outcome: { result: string } | { error: string }
			try {
				outcome = await handler(request.toolName, request.toolArgs, request.callbackId)
			} catch (err) {
				outcome = { error: err instanceof Error ? err.message : String(err) }
			}
			pub()
				.publish(toolResponseChannel(request.callbackId), JSON.stringify(outcome))
				.catch((err) => log.error({ callId, err: err.message }, 'failed to publish tool response'))
		})()
	})
	// The engine fast-fails on subscriber count — don't report registered
	// until the subscription is live.
	await ready

	let unregistered = false
	return {
		registered: true,
		unregister: () => {
			if (unregistered) return
			unregistered = true
			clearInterval(refresh)
			unsubscribe()
			// Compare-and-delete so we never release a lock a newer connection took over.
			void pub()
				.eval(
					`if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
					1,
					toolOwnerKey(callId),
					connectionId,
				)
				.catch((err: Error) => log.error({ callId, err: err.message }, 'failed to release tool owner lock'))
		},
	}
}

// ---------------------------------------------------------------------------
// Tool bridge — engine side (the worker running the call)
// ---------------------------------------------------------------------------

/**
 * Execute a tool on whichever process holds the SDK connection for this
 * call. Fails fast when no SDK connection is subscribed anywhere.
 */
export async function executeToolViaBus(
	callId: string,
	callbackId: string,
	toolName: string,
	toolArgs: Record<string, unknown>,
): Promise<{ result: string } | { error: string }> {
	const requestChannel = toolRequestChannel(callId)

	const [, subscriberCount] = (await pub().pubsub('NUMSUB', requestChannel)) as [string, number]
	if (!subscriberCount) return { error: 'No SDK tool handler connected' }

	let settled = false
	let settle!: (outcome: { result: string } | { error: string }) => void
	const outcome = new Promise<{ result: string } | { error: string }>((resolve) => {
		settle = (result) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			unsubscribe()
			resolve(result)
		}
	})

	const timeout = setTimeout(() => {
		settle({ error: `Tool "${toolName}" timed out waiting for SDK response` })
	}, toolBridgeTimeoutMs)

	const { unsubscribe, ready } = subscribeChannel(toolResponseChannel(callbackId), (message) => {
		try {
			settle(JSON.parse(message) as { result: string } | { error: string })
		} catch {
			settle({ error: `Tool "${toolName}" returned an unparseable response` })
		}
	})

	// The response channel must be live before the request goes out, or a
	// fast SDK reply could be published to nobody.
	await ready

	const payload: ToolRequestMessage = { callbackId, toolName, toolArgs }
	pub()
		.publish(requestChannel, JSON.stringify(payload))
		.catch((err) => settle({ error: `Tool "${toolName}" failed to reach the SDK: ${err.message}` }))

	return outcome
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function shutdownCallBus() {
	const closing: Array<Promise<unknown>> = []
	if (_pub) closing.push(_pub.quit().catch(() => {}))
	if (_sub) closing.push(_sub.quit().catch(() => {}))
	_pub = null
	_sub = null
	channelListeners.clear()
	await Promise.allSettled(closing)
}
