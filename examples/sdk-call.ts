/**
 * SDK client example — make a one-shot AI phone call.
 *
 * The SDK connects to the Mimic API, creates an agent from your goal,
 * starts the call, and polls until it completes. Tools run locally
 * in your process via WebSocket.
 *
 * Usage:
 *   MIMIC_API_KEY=... npx tsx examples/sdk-call.ts
 */

import { Mimic } from '@mimic/sdk'

const client = new Mimic({
	apiKey: process.env.MIMIC_API_KEY!,
	baseUrl: process.env.MIMIC_API_URL,
})

const result = await client.call({
	to: '+15551234567',
	goal: 'Confirm the appointment for tomorrow at 2pm with Dr. Smith',
	voice: 'female',
	context: {
		patientName: 'Jane Doe',
		appointmentDate: 'May 16, 2026',
		appointmentTime: '2:00 PM',
		doctorName: 'Dr. Smith',
		clinicName: 'Greenwood Medical',
	},
	tools: {
		reschedule: {
			description: 'Reschedule the appointment to a new date and time',
			parameters: {
				newDate: { type: 'string', description: 'The new date for the appointment' },
				newTime: { type: 'string', description: 'The new time for the appointment' },
			},
			async run(args) {
				console.log(`Rescheduling to ${args.newDate} at ${args.newTime}`)
				return `Appointment rescheduled to ${args.newDate} at ${args.newTime}`
			},
		},
	},
	results: {
		confirmed: 'Whether the appointment was confirmed (true/false)',
		notes: 'Any notes from the conversation',
	},
	timeoutMs: 3 * 60_000,
})

console.log('Call result:', {
	status: result.status,
	goalAchieved: result.goalAchieved,
	data: result.data,
	duration: result.duration,
})

for (const entry of result.transcript) {
	console.log(`[${entry.role}] ${entry.content}`)
}
