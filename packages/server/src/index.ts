export { createToolSocketBridge, requestToolExecutionOverSocket } from './tool-socket.js'
export type { ToolSocketCallError, ToolSocketCallRequest, ToolSocketCallResult } from './tool-socket.js'

export { compileGoal, buildOrchestratorConfigFromAgent } from './goal-compiler.js'
export type {
	AgentConfig,
	CompiledGoal,
	GoalCompilerInput,
	GoalContext,
	GoalData,
	GoalRecipient,
	GoalResults,
	GoalToolDefinition,
	GoalVoice,
} from './goal-compiler.js'
