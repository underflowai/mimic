import Handlebars from 'handlebars'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const promptsDir = resolve(import.meta.dirname, 'prompts')

export async function loadPrompt(name: string): Promise<string> {
	const filePath = resolve(promptsDir, `${name}.md`)
	return readFile(filePath, 'utf-8')
}

export async function renderPromptTemplate(name: string, data: Record<string, string | boolean>): Promise<string> {
	const template = await loadPrompt(name)
	const compiled = Handlebars.compile(template, { noEscape: true, strict: true })
	return compiled(data)
}
