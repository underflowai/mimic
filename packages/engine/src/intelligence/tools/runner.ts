/**
 * Tool definitions shared by the watcher, transport, and voice API wiring.
 */

import type { ToolKind } from './types.js'

export interface ToolDefinition {
	name: string
	description: string
	kind: ToolKind
	parameters: Record<string, unknown>
}
