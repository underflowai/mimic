export async function flushImmediate() {
	await new Promise<void>((resolve) => setImmediate(resolve))
}

export async function sleepMs(ms: number) {
	await new Promise<void>((resolve) => setTimeout(resolve, ms))
}
