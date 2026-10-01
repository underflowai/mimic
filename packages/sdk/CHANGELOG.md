# @underflowai/mimic

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
