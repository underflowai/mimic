import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, it } from 'node:test'

import { createSentenceChunkerTransform, type SentenceChunkEvent } from './sentence-chunker.js'

async function runChunker(tokens: string[]): Promise<SentenceChunkEvent[]> {
	const events: SentenceChunkEvent[] = []
	const source = Readable.from(tokens, { objectMode: true })
	const chunker = createSentenceChunkerTransform()

	const collector = new (await import('node:stream')).Writable({
		objectMode: true,
		write(chunk: SentenceChunkEvent, _encoding, callback) {
			events.push(chunk)
			callback()
		},
	})

	await pipeline(source, chunker, collector)
	return events
}

function deltaTexts(events: SentenceChunkEvent[]): string[] {
	return events.filter((e) => e.type === 'delta').map((e) => (e as { type: 'delta'; text: string }).text)
}

function joinDeltas(events: SentenceChunkEvent[]): string {
	return deltaTexts(events).join('')
}

function countBoundaries(events: SentenceChunkEvent[]): number {
	return events.filter((e) => e.type === 'boundary').length
}

function sentencesFromEvents(events: SentenceChunkEvent[]): string[] {
	const sentences: string[] = []
	let current = ''
	for (const event of events) {
		if (event.type === 'delta') current += event.text
		else {
			sentences.push(current)
			current = ''
		}
	}
	if (current.length > 0) sentences.push(current)
	return sentences
}

describe('createSentenceChunkerTransform', () => {
	it('passes through a single sentence and flushes a boundary at end', async () => {
		const events = await runChunker(['Hello world, how are you doing today?'])
		assert.equal(joinDeltas(events), 'Hello world, how are you doing today?')
		assert.equal(countBoundaries(events), 1)
		assert.equal(events[events.length - 1]?.type, 'boundary')
	})

	it('splits on `.`, `!`, and `?` between tokens', async () => {
		const events = await runChunker(['One. Two! Three? Four.'])
		assert.deepEqual(sentencesFromEvents(events), ['One.', ' Two!', ' Three?', ' Four.'])
	})

	it('does not split on abbreviations (Mr., Dr., etc.)', async () => {
		const events = await runChunker(['Mr. Smith met Dr. Jones at 5pm.'])
		assert.equal(countBoundaries(events), 1)
		assert.equal(joinDeltas(events), 'Mr. Smith met Dr. Jones at 5pm.')
	})

	it('does not split on e.g. / i.e.', async () => {
		const events = await runChunker(['Things like cats, e.g. kittens, are cute.'])
		assert.equal(countBoundaries(events), 1)
		assert.equal(joinDeltas(events), 'Things like cats, e.g. kittens, are cute.')
	})

	it('does not split on decimal numbers', async () => {
		const events = await runChunker(['Pi is about 3.14 and e is 2.71.'])
		assert.equal(countBoundaries(events), 1)
		assert.equal(joinDeltas(events), 'Pi is about 3.14 and e is 2.71.')
	})

	it('treats ellipsis followed by whitespace as a boundary', async () => {
		const events = await runChunker(['Hello... World is big.'])
		assert.deepEqual(sentencesFromEvents(events), ['Hello...', ' World is big.'])
	})

	it('keeps ellipsis attached when not followed by whitespace', async () => {
		const events = await runChunker(['Wait...not yet please.'])
		assert.equal(countBoundaries(events), 1)
		assert.equal(joinDeltas(events), 'Wait...not yet please.')
	})

	it('handles terminator straddling a token boundary', async () => {
		const events = await runChunker(['This is', ' a', ' test', '.', ' And more here.'])
		assert.deepEqual(sentencesFromEvents(events), ['This is a test.', ' And more here.'])
	})

	it('handles closing quote after terminator', async () => {
		const events = await runChunker(['She said "hi." Then she left.'])
		assert.deepEqual(sentencesFromEvents(events), ['She said "hi."', ' Then she left.'])
	})

	it('flushes trailing text without terminator', async () => {
		const events = await runChunker(['No terminator at end'])
		assert.equal(joinDeltas(events), 'No terminator at end')
		assert.equal(countBoundaries(events), 1)
	})

	it('emits short complete leading sentences immediately', async () => {
		const events = await runChunker(['Hi. How are you? I am fine and well, thanks for asking. Also, goodbye.'])
		assert.equal(countBoundaries(events), 4)
		const sentences = sentencesFromEvents(events)
		assert.equal(sentences[0], 'Hi.')
		assert.equal(sentences[1], ' How are you?')
		assert.equal(sentences[2], ' I am fine and well, thanks for asking.')
		assert.equal(sentences[3], ' Also, goodbye.')
	})

	it('emits a boundary for short complete output', async () => {
		const events = await runChunker(['Hi.'])
		assert.equal(countBoundaries(events), 1)
		assert.equal(joinDeltas(events), 'Hi.')
	})

	it('emits deltas incrementally before the boundary is known', async () => {
		const source = Readable.from(['The quick brown fox jumps', ' over the lazy dog', '.'], { objectMode: true })
		const chunker = createSentenceChunkerTransform()

		const events: SentenceChunkEvent[] = []
		const boundarySeenAfter: string[] = []
		let accumulated = ''

		const { Writable } = await import('node:stream')
		const collector = new Writable({
			objectMode: true,
			write(chunk: SentenceChunkEvent, _encoding, callback) {
				events.push(chunk)
				if (chunk.type === 'delta') accumulated += chunk.text
				else boundarySeenAfter.push(accumulated)
				callback()
			},
		})

		await pipeline(source, chunker, collector)

		// At least one delta emitted before the final boundary (token passthrough).
		const boundaryIndex = events.findIndex((e) => e.type === 'boundary')
		const deltaEventsBeforeBoundary = events.slice(0, boundaryIndex).filter((e) => e.type === 'delta')
		assert.ok(deltaEventsBeforeBoundary.length >= 1)
		assert.equal(joinDeltas(events), 'The quick brown fox jumps over the lazy dog.')
	})

	it('ignores empty string tokens', async () => {
		const events = await runChunker(['Hello', '', ' world.'])
		assert.equal(joinDeltas(events), 'Hello world.')
		assert.equal(countBoundaries(events), 1)
	})
})
