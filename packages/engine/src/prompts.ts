import Handlebars from 'handlebars'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const promptsDir = resolve(import.meta.dirname, 'prompts')

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

export async function renderPromptTemplate(name: string, data: Record<string, string | boolean>): Promise<string> {
	const template = await loadPrompt(name)
	const compiled = Handlebars.compile(template, { noEscape: true, strict: true })
	return compiled(data)
}
