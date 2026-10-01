import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
	endCallTag,
	extractTtsControlTags,
	holdTag,
	sanitizeForTranscript,
	sanitizeForTts,
	speechTagTextCanStream,
} from './tts-sanitizer.js'

describe('sanitizeForTts', () => {
	describe('markdown stripping', () => {
		const cases = [
			{ input: '**bold**', expected: 'bold', note: 'strips bold' },
			{ input: '*italic*', expected: 'italic', note: 'strips italic' },
			{ input: '***bold italic***', expected: 'bold italic', note: 'strips bold italic' },
			{ input: '`code`', expected: 'code', note: 'strips backticks' },
			{ input: 'he *sold* cars', expected: 'he sold cars', note: 'strips inline emphasis' },
			{ input: '# Heading', expected: 'Heading', note: 'strips heading markers' },
			{ input: '- bullet point', expected: 'bullet point', note: 'strips bullet markers' },
			{ input: '1. numbered', expected: 'numbered', note: 'strips numbered list markers' },
			{ input: '[click here](http://example.com)', expected: 'click here', note: 'strips markdown links' },
		]

		for (const { input, expected, note } of cases) {
			it(note, () => {
				assert.equal(sanitizeForTts(input), expected)
			})
		}
	})

	describe('Cartesia SSML tags preserved', () => {
		const cases = [
			{
				input: '<break time="500ms"/> Hello there!',
				expected: '<break time="500ms"/> Hello there!',
				note: 'preserves break tag',
			},
			{
				input: '<emotion value="calm"/> I understand.',
				expected: ' I understand.',
				note: 'strips unsupported emotion tag (space preserved for streaming boundaries)',
			},
			{
				input: '<spell>ABC-123</spell>',
				expected: '<spell>ABC-123</spell>',
				note: 'preserves spell tag',
			},
			{
				input: '[laughter] ha',
				expected: '[laughter] ha',
				note: 'preserves laughter non-verbal',
			},
			{
				input: 'Great news! <break time="1s"/> More to come.',
				expected: 'Great news! <break time="1s"/> More to come.',
				note: 'preserves inline break tag',
			},
		]

		for (const { input, expected, note } of cases) {
			it(note, () => {
				assert.equal(sanitizeForTts(input), expected)
			})
		}
	})

	describe('unsupported angle bracket tags stripped', () => {
		const cases = [
			{ input: '<emphasis>hi</emphasis>', expected: 'hi', note: 'strips paired emphasis tags' },
			{ input: '<slow>hello</slow>', expected: 'hello', note: 'strips paired slow tags' },
			{ input: '<whisper>quiet</whisper>', expected: 'quiet', note: 'strips paired whisper tags' },
			{ input: '<div>x</div>', expected: 'x', note: 'strips arbitrary HTML tags' },
			{ input: '<soft>hi</soft> and <fast>bye</fast>', expected: 'hi and bye', note: 'strips multiple paired tags' },
		]

		for (const { input, expected, note } of cases) {
			it(note, () => {
				assert.equal(sanitizeForTts(input), expected)
			})
		}
	})

	describe('streaming safety', () => {
		const cases = [
			{ input: 'plain text', expected: true, note: 'streams plain text' },
			{ input: 'before <emo', expected: false, note: 'holds split angle-bracket tag' },
			{ input: 'before <emotion value="calm"/>', expected: true, note: 'streams complete SSML tag' },
			{ input: 'no brackets here', expected: true, note: 'streams plain text' },
			{ input: 'text [laugh', expected: false, note: 'holds split square bracket tag' },
			{ input: 'text [laughter] ok', expected: true, note: 'streams complete square bracket tag' },
		]

		for (const { input, expected, note } of cases) {
			it(note, () => {
				assert.equal(speechTagTextCanStream(input), expected)
			})
		}
	})
})

describe('sanitizeForTranscript', () => {
	it('removes SSML tags from conversation history', () => {
		assert.equal(
			sanitizeForTranscript('<emotion value="calm"/> Hey Sarah, Aurora calling.'),
			'Hey Sarah, Aurora calling.',
		)
	})

	it('removes laughter non-verbal from transcript', () => {
		assert.equal(sanitizeForTranscript('[laughter] That is a good one.'), 'That is a good one.')
	})

	it('strips trailing JSON-looking tool arguments from spoken text', () => {
		assert.equal(
			sanitizeForTranscript('Still interested? {"date": "next Wednesday", "timezone": "America/Los_Angeles"}'),
			'Still interested?',
		)
	})
})

describe('extractTtsControlTags', () => {
	it('strips the end-call tag and reports it', () => {
		const { text, endCallRequested } = extractTtsControlTags(`Goodbye for now! ${endCallTag}`)
		assert.equal(text, 'Goodbye for now!')
		assert.equal(endCallRequested, true)
	})

	it('accepts spacing and case variants of the tag', () => {
		for (const variant of ['[END-CALL]', '[end call]', '[ end_call ]', '[EndCall]']) {
			const { text, endCallRequested } = extractTtsControlTags(`Bye. ${variant}`)
			assert.equal(text, 'Bye.', variant)
			assert.equal(endCallRequested, true, variant)
		}
	})

	it('leaves other square-bracket tags alone', () => {
		const { text, endCallRequested, holdRequested } = extractTtsControlTags('[laughter] That is funny.')
		assert.equal(text, '[laughter] That is funny.')
		assert.equal(endCallRequested, false)
		assert.equal(holdRequested, false)
	})

	it('strips the hold tag and reports it', () => {
		const { text, endCallRequested, holdRequested } = extractTtsControlTags(`Sure, take your time. ${holdTag}`)
		assert.equal(text, 'Sure, take your time.')
		assert.equal(holdRequested, true)
		assert.equal(endCallRequested, false)
	})

	it('accepts variants of the hold tag', () => {
		for (const variant of ['[HOLD]', '[hold on]', '[ hold_on ]', '[holding]']) {
			const { text, holdRequested } = extractTtsControlTags(`Of course. ${variant}`)
			assert.equal(text, 'Of course.', variant)
			assert.equal(holdRequested, true, variant)
		}
	})

	it('reports both tags independently', () => {
		const { text, endCallRequested, holdRequested } = extractTtsControlTags(`Bye. ${holdTag} ${endCallTag}`)
		assert.equal(text, 'Bye.')
		assert.equal(endCallRequested, true)
		assert.equal(holdRequested, true)
	})

	it('does not trim the ends of a delta, so streamed deltas still join correctly', () => {
		const { text } = extractTtsControlTags('hello ')
		assert.equal(text, 'hello ')
	})

	it('never reaches TTS or the transcript', () => {
		assert.equal(sanitizeForTts(`Take care! ${endCallTag}`), 'Take care!')
		assert.equal(sanitizeForTranscript(`Take care! ${endCallTag}`), 'Take care!')
		assert.equal(sanitizeForTts(`One moment. ${holdTag}`), 'One moment.')
		assert.equal(sanitizeForTranscript(`One moment. ${holdTag}`), 'One moment.')
	})
})
