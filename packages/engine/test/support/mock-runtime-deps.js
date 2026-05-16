/**
 * Shared mock-deps builder for call-machine-runtime tests.
 *
 * Provides:
 *   - a fake `AudioTransport` that collects written PCM chunks,
 *   - a fake TTS speaker that emits a single frame per synthesis,
 *   - a minimal director / metrics / search stack.
 *
 * Tests can override individual deps via the `overrides` argument.
 */
import { mock } from 'node:test';
import { ttsFrameBytes } from '#engine/shared/audio-pacing.js';
import { createFakeAudioTransport } from './fake-audio-transport.js';
function makeFakeTts(emitAudio) {
    return {
        connect: mock.fn(async () => { }),
        close: mock.fn(() => { }),
        interrupt: mock.fn(),
        speakAndWait: mock.fn(async (_text, onChunk) => {
            if (emitAudio)
                onChunk(Buffer.alloc(ttsFrameBytes, 1));
        }),
        preSendTextForSynthesis: mock.fn(async (_text, onChunk) => ({
            pushTextDelta: () => { },
            triggerSynthesisStart: () => {
                if (emitAudio)
                    onChunk(Buffer.alloc(ttsFrameBytes, 1));
            },
            audioComplete: Promise.resolve(),
        })),
    };
}
export function createMockRuntimeDeps(options = {}) {
    const emitAudio = options.emitAudio ?? true;
    const transport = createFakeAudioTransport();
    const deps = {
        callSignal: new AbortController().signal,
        tts: makeFakeTts(emitAudio),
        specTts: makeFakeTts(emitAudio),
        director: {
            generateDraft: mock.fn(async (transcript) => ({
                userTranscript: transcript,
                agentResponse: 'mock response',
            })),
            streamDraftTokenized: mock.fn((transcript) => ({
                userTranscript: transcript,
                events: (async function* () {
                    yield { type: 'token', value: 'mock response' };
                    return 'mock response';
                })(),
            })),
            commitTurn: mock.fn(),
            listTurns: () => [],
        },
        backgroundClient: {
            chat: {
                completions: {
                    create: mock.fn(async () => ({
                        choices: [{ message: { content: '{"needsTool":false,"toolName":null}' } }],
                    })),
                },
            },
        },
        metrics: {
            recordBarge: mock.fn(),
            recordSpeculation: mock.fn(),
            recordSoftPause: mock.fn(),
            recordTurnOutcome: mock.fn(),
            recordTurnTiming: mock.fn(),
            incrementDiscarded: mock.fn(),
        },
        getAudioTransport: () => transport,
        backgroundIntelligence: {
            classifySilenceReason: mock.fn(),
            runPostCommitTasks: mock.fn(async () => ({ transcriptReliable: true })),
            getLatestPostCommitResults: mock.fn(() => ({ transcriptReliable: true })),
            addKeyterms: mock.fn(),
            drain: mock.fn(async () => { }),
        },
        incrementTurn: mock.fn(),
        configureTranscriber: mock.fn(),
        sanitize: (text) => text,
        classifyPromotion: mock.fn(async () => false),
        buildControlBlock: mock.fn(() => 'mock control block'),
        webSearcher: { search: mock.fn(async () => null) },
        getCallerDateTime: () => undefined,
        getDirectorTurns: () => [],
        onSilenceHangup: mock.fn(),
        ...options.overrides,
    };
    return { deps, transport };
}
//# sourceMappingURL=mock-runtime-deps.js.map