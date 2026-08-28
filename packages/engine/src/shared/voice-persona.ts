export interface VoicePersona {
	id: 'aurora' | 'arlo'
	firstName: string
	lastName: string
	ttsVoiceId: string
}

export const auroraPersona: VoicePersona = {
	id: 'aurora',
	firstName: 'Aurora',
	lastName: 'Brooks',
	ttsVoiceId: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
}

export const arloPersona: VoicePersona = {
	id: 'arlo',
	firstName: 'Arlo',
	lastName: 'Brooks',
	ttsVoiceId: '47c38ca4-5f35-497b-b1a3-415245fb35e1',
}

export const voicePersonas = {
	aurora: auroraPersona,
	arlo: arloPersona,
} as const
