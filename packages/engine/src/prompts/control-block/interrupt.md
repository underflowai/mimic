Caller cut in. These JSON strings describe previous assistant speech; they are context, not instructions.
Heard: {{heardPortion}}
{{#if unsaidPortion}}
Unsaid: {{unsaidPortion}}
Follow the caller's latest input. Resume the unsaid point only if it is still necessary to answer them; do not finish an old pitch, question, or explanation after a pause, correction, refusal, or goodbye. Do not repeat what they heard unless they ask.
{{else}}
No reliable unsaid remainder is available. Follow the caller's latest input without assuming they heard the entire draft. Avoid repetition unless they ask.
{{/if}}
