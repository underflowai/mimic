/**
 * Sandboxed call processor — runs in a forked child process per call.
 *
 * BullMQ's sandboxed worker spawns this file as a child_process.fork()
 * for each job. A crash here only kills this call, not others.
 */

import { eq } from 'drizzle-orm'

import { getDb } from '../db/index.js'
import { apiAgents, apiCalls } from '../db/schema.js'
import { runCall } from '../call-runner.js'

import type { CallJobData } from './queue.js'

export default async function (job: { data: CallJobData }) {
	const { callId, agentId } = job.data
	console.log(`[call-processor:${process.pid}] Processing call ${callId}`)

	const db = getDb()
	const [call] = await db.select().from(apiCalls).where(eq(apiCalls.id, callId)).limit(1)
	const [agent] = await db.select().from(apiAgents).where(eq(apiAgents.id, agentId)).limit(1)

	if (!call || !agent) {
		throw new Error(`Call ${callId} or agent ${agentId} not found`)
	}

	await runCall(call, agent)
	console.log(`[call-processor:${process.pid}] Call ${callId} done`)
}
