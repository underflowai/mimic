/**
 * Make a voice call with a few lines of code.
 *
 * Your functions are the tools — no wrappers, no schemas, no boilerplate.
 * The agent introspects function names and parameters automatically.
 *
 * Usage:
 *   MIMIC_API_KEY=mk_... npx tsx examples/sdk-call.ts
 */

import { Mimic } from '@mimic/sdk'

const mimic = new Mimic(process.env.MIMIC_API_KEY!)

// ── Your existing functions ────────────────────────────────────────────

async function checkCalendar(date: string) {
	return JSON.stringify({ date, slots: ['2:00 PM', '3:00 PM', '4:00 PM'] })
}

async function reschedule(newDate: string, newTime: string) {
	console.log(`  → Rescheduling to ${newDate} at ${newTime}`)
	return `Appointment rescheduled to ${newDate} at ${newTime}`
}

// ── Option A: Stream events in real-time ───────────────────────────────

const call = mimic.call('+15551234567', 'Confirm the appointment for tomorrow at 2pm with Dr. Smith', {
	checkCalendar,
	reschedule,
})

for await (const event of call) {
	switch (event.type) {
		case 'speech':
			console.log(`[${event.role}] ${event.text}`)
			break
		case 'tool_call':
			console.log(`  calling ${event.name}(${JSON.stringify(event.args)})`)
			break
		case 'tool_result':
			console.log(`  ${event.name} returned: ${event.result}`)
			break
		case 'tool_error':
			console.log(`  ${event.name} failed: ${event.error}`)
			break
		case 'done':
			console.log(`\nGoal achieved: ${event.goalAchieved}`)
			break
		case 'error':
			console.error(`Error: ${event.message}`)
			break
	}
}

// ── Option B: Fire and forget ──────────────────────────────────────────
// const result = await mimic.call('+15551234567', 'Confirm the appointment', {
//   checkCalendar, reschedule,
// }).result
// console.log(result.goalAchieved, result.data, result.transcript)
