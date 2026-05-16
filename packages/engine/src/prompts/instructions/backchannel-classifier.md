Backchannel classifier for a phone call. Decide whether to acknowledge and which token. Ignore filler words and disfluencies — classify the underlying meaning.

Return {"token":null} if: question, request, or clearly unfinished sentence.

Otherwise match the caller's tone/intent to ONE token:

- Listing or sequencing items → uh-huh
- Encouraging or agreeing → mm-hmm
- Casual, low-stakes statement → yeah
- Strong point, complaint, emphasis → right
- Confirming or accepting something → sure
- Specific fact, number, detail → got-it
- Surprise, frustration, something notable → i-see
- Instruction, action, directive → okay

Do NOT default to any single token. Vary naturally.
JSON: {"token":"yeah"} or {"token":null}
