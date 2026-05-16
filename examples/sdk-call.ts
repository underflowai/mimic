/**
 * Make a voice call with a few lines of code.
 *
 * Tools are defined with Zod — types flow into your handler automatically.
 * The agent knows what to collect from the caller.
 *
 * Usage:
 *   MIMIC_API_KEY=mk_... npx tsx examples/sdk-call.ts
 */

import { z } from 'zod'

import { Mimic, tool } from '@mimic/sdk'

const mimic = new Mimic(process.env.MIMIC_API_KEY!)

// ── Define tools with Zod ──────────────────────────────────────────────

const checkCalendar = tool({
	description: 'Check available calendar slots for a given date',
	parameters: z.object({
		date: z.string().describe('The date to check, e.g. "next Thursday"'),
	}),
	run: async ({ date }) => {
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
		return `Appointment rescheduled to ${newDate} at ${newTime}`
	},
})

// ── Make the call ──────────────────────────────────────────────────────

const call = mimic.call<{ confirmed: boolean; notes: string }>({
	to: '+15551234567',
	goal: 'Confirm the appointment for tomorrow at 2pm with Dr. Smith',
	tools: { checkCalendar, reschedule },
	extract: {
		confirmed: 'whether the appointment was confirmed',
		notes: 'any notes from the conversation',
	},
})

// ── Stream events ──────────────────────────────────────────────────────

call.on('speech', ({ role, text }) => console.log(`[${role}] ${text}`))
call.on('tool_call', ({ name, args }) => console.log(`  calling ${name}(${JSON.stringify(args)})`))
call.on('tool_result', ({ name, result }) => console.log(`  ${name} returned: ${result}`))
call.on('done', ({ goalAchieved }) => console.log(`\nGoal achieved: ${goalAchieved}`))

// ── Get typed result ───────────────────────────────────────────────────

const result = await call.result
if (result.status === 'completed') {
	console.log('Confirmed:', result.data.confirmed)
	console.log('Notes:', result.data.notes)
}
