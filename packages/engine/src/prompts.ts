import Handlebars from 'handlebars'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const promptsDir = resolve(import.meta.dirname, 'prompts')

/** A compiled Handlebars prompt; call it with the template's variables. */
export type PromptTemplate = (data: Record<string, string | boolean>) => string

export async function loadPrompt(name: string): Promise<string> {
	const normalizedName = name.replaceAll('\\', '/').replace(/^\/+/, '')
	if (!normalizedName.trim()) {
		throw new Error('Prompt name is required')
	}
	const filePath = resolve(promptsDir, `${normalizedName}.md`)
	const rel = relative(promptsDir, filePath)
	if (isAbsolute(rel) || rel.startsWith('..')) {
		throw new Error(`Invalid prompt name: "${name}"`)
	}
	return readFile(filePath, 'utf-8')
}

/** Compile a prompt template once; render it many times (per-turn fragments). */
export async function loadPromptTemplate(name: string): Promise<PromptTemplate> {
	const template = await loadPrompt(name)
	return Handlebars.compile(template, { noEscape: true, strict: true })
}

export async function renderPromptTemplate(name: string, data: Record<string, string | boolean>): Promise<string> {
	const render = await loadPromptTemplate(name)
	return render(data)
}
