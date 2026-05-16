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
	ttsVoiceId: 'f786b574-daa5-4673-aa0c-cbe3e8534c02',
}

export const arloPersona: VoicePersona = {
	id: 'arlo',
	firstName: 'Arlo',
	lastName: 'Brooks',
	ttsVoiceId: 'a5136bf9-224c-4d76-b823-52bd5efcffcc',
}

export const voicePersonas = {
	aurora: auroraPersona,
	arlo: arloPersona,
} as const
