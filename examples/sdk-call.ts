/**
 * Make a voice call with a few lines of code.
 *
 * Define tools with Zod schemas — the types flow into your handler
 * automatically. The agent knows what to collect from the caller.
 *
 * Usage:
 *   MIMIC_API_KEY=mk_... npx tsx examples/sdk-call.ts
 */

import { z } from 'zod'

import { Mimic, tool } from '@mimic/sdk'

const mimic = new Mimic(process.env.MIMIC_API_KEY!)

// ── Define tools with Zod — types flow into your handler ───────────────

const checkCalendar = tool({
	description: 'Check available calendar slots for a given date',
	parameters: z.object({
		date: z.string().describe('The date to check, e.g. "next Thursday"'),
	}),
	run: async ({ date }) => {
		// date is typed as string — inferred from the schema
		return JSON.stringify({ date, slots: ['2:00 PM', '3:00 PM', '4:00 PM'] })
	},
})

const reschedule = tool({
	description: 'Reschedule an appointment to a new date and time',
	parameters: z.object({
		newDate: z.string().describe('The new date'),
		newTime: z.string().describe('The new time'),
	}),
	run: async ({ newDate, newTime }) => {
		console.log(`  Rescheduling to ${newDate} at ${newTime}`)
		return `Appointment rescheduled to ${newDate} at ${newTime}`
	},
})

// ── Make the call ──────────────────────────────────────────────────────

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
