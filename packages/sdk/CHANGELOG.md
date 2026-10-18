# @underflowai/mimic

## Unreleased

Added

- `mimic.compile(options)` writes the agent's prompt from a goal (plus
  `context`, `tools`, `voice`, `aiDisclosure`, `channel`) and returns it as a
  `Prompt` (`{ goal, systemPrompt, turnControlBlock, agentName }`). Nothing is
  stored; keep and edit the prompt as you like.
- `CallOptions.prompt`: pass a `Prompt` instead of `goal`. The prompt is used
  verbatim and never recompiled. `CallOptions` now requires exactly one of
  `goal` or `prompt`. New exports: `Prompt`, `CompileOptions`, `CallOptionsBase`.
- Web calls. Pass `channel: 'web'` with no `to` and the person joins from a
  browser instead of being dialed. `call.web` resolves with `{ url, token }`
  (a one-hour LiveKit token scoped to the call's room) as soon as the call is
  created, or `null` for phone calls. `to` is now optional in `CallOptions`
  and required only for phone calls.
- `mimic.calls.get(id)`, `mimic.calls.list({ limit, cursor, status })`, and
  `mimic.calls.cancel(id)`: calls outlive the `MimicCall` object. `Call` is
  the record (`status`, `channel`, `to`, `createdAt`, `duration`,
  `goalAchieved`, `data`, `transcript`, `toolCalls`, `error`, `recordingUrl`).
- `call.id` resolves with the call's id as soon as the API has created it.
- `recordingUrl` on completed results and call records: a signed link to the
  audio, valid for an hour. `toolCalls` on completed results.
- `result.data` is typed from the `extract` schema; no generic needed.
  `extract` fields may be enums (`z.enum`) and arrays of strings, numbers, or
  booleans; the agent is told the allowed values and the extractor is held to
  them.
- `webhookSecret` signs webhook deliveries (`x-mimic-signature: t=...,v1=...`);
  `verifyWebhook({ payload, signature, secret })` checks them. New type
  `WebhookEvent`.

Changed

- Webhooks fire when a call fails or is cancelled too, not only when it
  completes. The body is `{ event: 'call.completed' | 'call.failed', call }`
  with `call` exactly as `mimic.calls.get()` returns it. Deliveries are
  retried. Changing the webhook URL no longer creates a new agent.
- `timeoutMs` defaults to 60 minutes (the server's maximum) instead of 5, and
  cancels the call when it elapses rather than abandoning a call that keeps
  running without its tools.
- Server: `GET /calls/:id` returns `data`, `error`, `to`, `createdAt`,
  `toolCalls`, and `recordingUrl` (replacing `result`, `errorMessage`, and
  `recordingPath`); `GET /calls` lists calls.

- `data` and `extract` no longer shape the compiled prompt. They are appended
  to it at runtime, so changing the fields you confirm or ask for never
  triggers a recompile. Compiled prompts recompile once to pick this up.
- Web calls bring up speech services and recording only once the visitor is
  in the room. Before, a visitor who took over a minute to join hit a Deepgram
  idle disconnect, and no-shows recorded two minutes of empty room.

Fixed

- `call.cancel()` reports it through the `error` event when the server refuses
  the cancel, instead of hiding the failure while the call keeps running.
- Server: cancelling a call failed with a 500 in production because the
  `call_status` enum there never received `cancelled`.
- Server: a call that fails during startup (a web call nobody joined) no longer
  races its own end-of-session path, and its room is deleted.

Removed

- `persona`. Pass a `Prompt` as `prompt` instead, with `goal` inside it.
- API keys starting with `sk_` are no longer accepted. Every key the server
  issues starts with `mk_`.

## 0.3.0

Breaking changes

- `result.data` fields are `T | null`. A field is `null` when the call did not
  establish it, including booleans and fields your schema marks required.
  Check `=== null` before treating `false` or `''` as an answer. The exported
  `ExtractedData<T>` type reflects this.
- Tool parameters are sent to the API as JSON Schema (types, enums, nesting,
  required/optional) instead of a `{ name: description }` map. `ToolSchema.parameters`
  is now `Record<string, unknown>`.

Added

- `kind: 'read' | 'write'` on `tool()`. Writes wait for the caller's explicit
  go-ahead before running; reads run as soon as the request is clear. Omitted
  `kind` is `read`, which matches how every tool behaved before this option
  existed. MCP tools are reads only when the server sets `readOnlyHint: true`.
- `userTimezone` call option (IANA name). When omitted, the server guesses from
  the phone number's area code and the agent confirms the guess the first time
  a specific time matters.
- Zod 4 schemas (`zod/v4`) are accepted alongside Zod 3 for tool parameters.

Changed

- `@modelcontextprotocol/sdk` is loaded only when `mimic.mcp()` is called.

## 0.2.0

- Package renamed to `@underflowai/mimic`.
