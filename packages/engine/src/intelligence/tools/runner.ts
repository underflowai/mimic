/**
 * Tool definitions shared by the watcher, transport, and voice API wiring.
 */

import type { ToolKind } from './types.js'

export interface ToolDefinition {
	name: string
	description: string
	kind: ToolKind
	/** JSON Schema for the tool's arguments (`{ type: 'object', properties, required }`). */
	parameters: Record<string, unknown>
	/**
	 * The caller must explicitly confirm before this tool may run. WRITE
	 * tools default to requiring confirmation; set `false` to opt out.
	 */
	requiresConfirmation?: boolean
}
