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

import { Mimic, tool } from '@underflowai/mimic'

const mimic = new Mimic(process.env.MIMIC_API_KEY!)

// Demo handlers below return simulated data. Replace them with real calendar
// lookups and writes before using this workflow for real appointments.

// ── Define tools with Zod ──────────────────────────────────────────────

const checkCalendar = tool({
	kind: 'read',
	description: 'Check available calendar slots for a given date',
	parameters: z.object({
		date: z.string().describe('The date to check, e.g. "next Thursday"'),
	}),
	run: async ({ date }) => {
		return JSON.stringify({ date, slots: ['2:00 PM', '3:00 PM', '4:00 PM'] })
	},
})

const reschedule = tool({
	kind: 'write',
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
	goal: 'Demonstrate confirming or rescheduling a simulated appointment for tomorrow at 2pm with Dr. Smith.',
	context:
		'This is a calendar simulation. Slots and rescheduling confirmations from the tools are demo data, not real appointments. Make that clear to the caller.',
	userTimezone: 'America/New_York',
	tools: { checkCalendar, reschedule },
	extract: z.object({
		confirmed: z.boolean().describe('whether the appointment was confirmed'),
		notes: z.string().describe('any notes from the conversation'),
	}),
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
