import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3'

import type { CallEventRecord } from '@mimic/engine'

import { createEventLogStorage, eventLogKey, type EventLogS3Client } from './event-log-storage.js'

const env = {
	RECORDING_S3_BUCKET: 'mimic-recordings',
	RECORDING_S3_ACCESS_KEY: 'key',
	RECORDING_S3_SECRET: 'secret',
	RECORDING_S3_ENDPOINT: 'https://r2.example.com',
}

function fakeS3() {
	const objects = new Map<string, string>()
	const sent: unknown[] = []
	let clientConfig: S3ClientConfig | null = null
	const client: EventLogS3Client = {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		send: (async (command: any) => {
			sent.push(command)
			if (command instanceof PutObjectCommand) {
				objects.set(command.input.Key!, String(command.input.Body))
				return {}
			}
			if (command instanceof GetObjectCommand) {
				const body = objects.get(command.input.Key!)
				if (body === undefined) throw new Error('NoSuchKey')
				return { Body: { transformToString: async () => body } }
			}
			if (command instanceof ListObjectsV2Command) {
				const keys = [...objects.keys()].filter((k) => k.startsWith(command.input.Prefix ?? '')).sort()
				return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false }
			}
			throw new Error(`unexpected command ${command.constructor.name}`)
		}) as EventLogS3Client['send'],
	}
	return {
		client,
		objects,
		sent,
		configOf: () => clientConfig,
		create: (config: S3ClientConfig) => {
			clientConfig = config
			return client
		},
	}
}

describe('event log storage', () => {
	it('is disabled without a bucket', () => {
		assert.equal(createEventLogStorage({}), null)
	})

	it('writes JSONL beside the recordings and reads it back', async () => {
		const s3 = fakeS3()
		const storage = createEventLogStorage(env, s3.create)!
		const events: CallEventRecord[] = [
			{ seq: 0, atMs: 0, type: 'vad_speech_start', actor: 'call', data: {} },
			{ seq: 1, atMs: 320, type: 'caller_turn_complete', actor: 'call', data: { transcript: 'hi', confidence: 0.9 } },
		]

		const key = await storage.persist('call-123', events)
		assert.equal(key, eventLogKey('call-123'))
		assert.equal(key, 'call-events/call-123.jsonl')
		assert.equal(s3.objects.get(key)!.split('\n').filter(Boolean).length, 2)

		const put = s3.sent[0] as PutObjectCommand
		assert.equal(put.input.Bucket, 'mimic-recordings')
		assert.equal(put.input.ContentType, 'application/x-ndjson')

		assert.deepEqual(await storage.fetch(key), events)
		assert.deepEqual(await storage.list(), [key])
	})

	it('uses the shared recording credentials and virtual-hosted URLs by default', () => {
		const s3 = fakeS3()
		createEventLogStorage(env, s3.create)
		const config = s3.configOf()!
		assert.equal(config.endpoint, 'https://r2.example.com')
		assert.equal(config.forcePathStyle, undefined)
		assert.deepEqual(config.credentials, { accessKeyId: 'key', secretAccessKey: 'secret' })
		assert.equal(config.region, 'us-east-1')
	})

	it('switches to path-style URLs only when asked', () => {
		const s3 = fakeS3()
		createEventLogStorage({ ...env, RECORDING_S3_FORCE_PATH_STYLE: 'true' }, s3.create)
		assert.equal(s3.configOf()!.forcePathStyle, true)
	})
})
