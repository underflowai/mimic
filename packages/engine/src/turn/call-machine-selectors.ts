import {
	getEagerChildSnapshot,
	getTurnActorSnapshot,
	matchTurnActorState,
	type CallMachineSnapshot,
} from './call-machine.js'

const eagerInFlightStates = new Set(['eagerGenerating', 'ready', 'validating'])

function isIdle(snapshot: CallMachineSnapshot) {
	return snapshot.matches('idle')
}

function isEagerChildInFlight(snapshot: CallMachineSnapshot) {
	const eager = getEagerChildSnapshot(snapshot)
	if (!eager) return false
	return eagerInFlightStates.has(String(eager.value))
}

export function isAgentSpeaking(snapshot: CallMachineSnapshot) {
	const turnActorSnapshot = getTurnActorSnapshot(snapshot)
	if (!turnActorSnapshot) return false
	return (
		matchTurnActorState(turnActorSnapshot, 'executing.streaming') ||
		matchTurnActorState(turnActorSnapshot, 'executing.softPaused') ||
		matchTurnActorState(turnActorSnapshot, 'awaitingPlayback') ||
		matchTurnActorState(turnActorSnapshot, 'committing')
	)
}

export function shouldSuppressBackchannel(snapshot: CallMachineSnapshot) {
	return !isIdle(snapshot) || isEagerChildInFlight(snapshot)
}
