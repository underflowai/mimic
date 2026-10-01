/**
 * Endpointing policy — when to make the transcriber wait longer.
 *
 * Flux's end-of-turn model is tuned for conversation. Values read out in
 * pieces (an email address, a phone number, a spelled name) have natural
 * pauses that look like turn ends: "john dot ... smith at ...". When the
 * agent has just asked for one of these, the runtime raises the EOT bar for
 * the caller's next turn. This module only decides *whether* an agent line
 * is such a request.
 */

const valueRequest =
	/\b(e-?mail( address)?|phone( number)?|mobile( number)?|cell( number)?|telephone|contact number|callback number|spell(ing|ed)?|zip( code)?|postal code|post ?code|(street|mailing|billing|shipping|home) address|card number|credit card|account number|confirmation (number|code)|reference (number|code)|booking (number|code|reference)|order (number|id)|tracking number|policy number|member(ship)? (id|number)|case number|ticket number|invoice number|date of birth|birth ?date|license plate|plate number|serial number|social security|routing number|verification code|one[- ]time (code|password)|passcode|pin( code)?|extension|digits?|letter by letter)\b/i

const readOutCue = /\b(spell|read (it |that |me |them )?(out|back)|go ahead|digit by digit|one at a time)\b/i

/** True when the agent's line asks the caller to read out a value piece by piece. */
export function shouldUseCarefulEndpointing(agentResponse: string): boolean {
	const text = agentResponse.trim()
	if (!text) return false
	if (!valueRequest.test(text)) return false
	// Requests end in a question or an explicit invitation to read out.
	return /\?\s*$/.test(text) || readOutCue.test(text)
}
