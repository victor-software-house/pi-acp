/**
 * Exhaustive switch/case helper.
 *
 * Writes unknown values to stderr instead of silently ignoring them, aiding
 * debugging when the pi SDK adds new event types. Never write to stdout: it
 * carries the ACP NDJSON stream and any other byte poisons the protocol.
 */
export function unreachable(value: never, context?: string): void {
	const label = context !== undefined ? `[${context}] ` : "";
	process.stderr.write(`${label}Unhandled value: ${String(value)}\n`);
}
