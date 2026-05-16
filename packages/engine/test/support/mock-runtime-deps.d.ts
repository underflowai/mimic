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
import type { CallMachineRuntimeDeps } from '#engine/turn/call-machine-runtime.js';
import { type FakeAudioTransport } from './fake-audio-transport.js';
export interface MockRuntimeBuildOptions {
    overrides?: Partial<CallMachineRuntimeDeps>;
    emitAudio?: boolean;
}
export interface MockRuntimeBundle {
    deps: CallMachineRuntimeDeps;
    transport: FakeAudioTransport;
}
export declare function createMockRuntimeDeps(options?: MockRuntimeBuildOptions): MockRuntimeBundle;
//# sourceMappingURL=mock-runtime-deps.d.ts.map