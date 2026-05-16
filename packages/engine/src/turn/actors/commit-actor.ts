/**
 * Commit Actor — writes the final draft to the director and records timing.
 *
 * Extracted from the engine's `commitTurn()` body. Invoked by TurnActor's
 * `committing` state. The actual commit work (director writes, briefing
 * increment, timing metrics) is synchronous — the Promise wrapper exists
 * only so `fromPromise` can model the lifecycle.
 *
 * Dependencies are passed via `input.deps` so the actor is a pure function
 * of its input with no module-scoped state.
 *
 * Commit signal is a never-aborting signal by design. A half-written
 * director history corrupts all future turns.
 */

import { fromPromise } from 'xstate'

import { createLogger } from '#engine/logger.js'

import { sanitizeForTranscript } from '../../audio/tts-sanitizer.js'
import type { CommittedTurnContent } from '../../intelligence/director.js'
import type { TurnTiming } from '../../shared/metrics.js'
import type { CommittedTurn } from '../types.js'

const log = createLogger('mimic:commit')

export interface CommitActorDeps {
	director: {
		commitTurn: (content: CommittedTurnContent) => void
	}
	incrementTurn: () => void
	metrics: {
		recordTurnTiming: (timing: TurnTiming) => void
	}
}

export interface CommitActorInput {
	turnId: number
	userTranscript: string
	agentResponse: string
	endCallRequested: boolean
	generationStartedAt: number
	generationToAudioCompleteMs: number
	firstAudioAt: number | null
	ttsFirstByteMs: number | null
	llmFirstTokenMs: number | null
	llmCompleteMs: number | null
	timingKind: TurnTiming['kind']
	lastTurnCompleteAt: number
	lastVadSpeechEndAt: number
	deps: CommitActorDeps
}

export type CommitActorOutput = { committedTurn: CommittedTurn } | null

export const commitActorLogic = fromPromise<CommitActorOutput, CommitActorInput>(async ({ input }) => {
	const {
		turnId,
		userTranscript,
		agentResponse,
		endCallRequested,
		generationStartedAt,
		generationToAudioCompleteMs,
		firstAudioAt,
		ttsFirstByteMs,
		llmFirstTokenMs,
		llmCompleteMs,
		timingKind,
		lastTurnCompleteAt,
		lastVadSpeechEndAt,
		deps,
	} = input

	const normalizedAgentResponse = sanitizeForTranscript(agentResponse)
	const commitPayload: CommittedTurnContent = !userTranscript
		? { kind: 'greeting', agent: normalizedAgentResponse }
		: { kind: 'exchange', user: userTranscript, agent: normalizedAgentResponse }
	deps.director.commitTurn(commitPayload)
	deps.incrementTurn()

	const generationToFirstAudioMs = firstAudioAt ? firstAudioAt - generationStartedAt : null
	const turnCompleteToFirstAudioMs = firstAudioAt && lastTurnCompleteAt > 0 ? firstAudioAt - lastTurnCompleteAt : null
	const vadEndToTurnCompleteMs = nonNegativeDelta(lastVadSpeechEndAt, lastTurnCompleteAt)
	const vadEndToFirstAudioMs =
		lastVadSpeechEndAt > 0 && firstAudioAt ? nonNegativeDelta(lastVadSpeechEndAt, firstAudioAt) : null

	deps.metrics.recordTurnTiming(
		buildTurnTiming({
			turnId,
			generationToAudioCompleteMs,
			generationToFirstAudioMs,
			timingKind,
			turnCompleteToFirstAudioMs,
			vadEndToTurnCompleteMs,
			vadEndToFirstAudioMs,
			ttsFirstByteMs,
			llmFirstTokenMs,
			llmCompleteMs,
		}),
	)

	log.info(
		{
			turnId,
			agentResponse: normalizedAgentResponse,
			generationToAudioCompleteMs,
			generationToFirstAudioMs,
			turnCompleteToFirstAudioMs,
			vadEndToTurnCompleteMs,
			vadEndToFirstAudioMs,
			ttsFirstByteMs,
			llmFirstTokenMs,
			llmCompleteMs,
		},
		'committed',
	)

	return {
		committedTurn: {
			turnId,
			userTranscript,
			agentResponse: normalizedAgentResponse,
			endCallRequested,
		},
	}
})

type TurnTimingBuildInput = {
	turnId: number
	generationToAudioCompleteMs: number
	generationToFirstAudioMs: number | null
	timingKind: TurnTiming['kind']
	turnCompleteToFirstAudioMs: number | null
	vadEndToTurnCompleteMs: number | null
	vadEndToFirstAudioMs: number | null
	ttsFirstByteMs: number | null
	llmFirstTokenMs: number | null
	llmCompleteMs: number | null
}

function buildTurnTiming(input: TurnTimingBuildInput): TurnTiming {
	const llmAvailable = input.timingKind === 'fresh' || input.timingKind === 'first_turn'
	const ttsFirstByteAvailable = input.timingKind !== 'presynthesized'
	switch (input.timingKind) {
		case 'fresh':
		case 'presynthesized':
		case 'first_turn':
			return {
				turnId: input.turnId,
				kind: input.timingKind,
				generationToAudioCompleteMs: input.generationToAudioCompleteMs,
				generationToFirstAudioMs: input.generationToFirstAudioMs,
				turnCompleteToFirstAudioMs: input.turnCompleteToFirstAudioMs,
				vadEndToTurnCompleteMs: input.vadEndToTurnCompleteMs,
				vadEndToFirstAudioMs: input.vadEndToFirstAudioMs,
				ttsFirstByteMs: ttsFirstByteAvailable ? input.ttsFirstByteMs : null,
				llmFirstTokenMs: llmAvailable ? input.llmFirstTokenMs : null,
				llmCompleteMs: llmAvailable ? input.llmCompleteMs : null,
			}
	}
}

function nonNegativeDelta(startAt: number, endAt: number) {
	if (startAt <= 0 || endAt <= 0) return null
	if (endAt < startAt) return null
	return endAt - startAt
}
