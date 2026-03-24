/**
 * Exhaustive switch/case helper.
 *
 * Logs unknown values instead of silently ignoring them, aiding debugging
 * when the pi SDK adds new event types.
 */
export function unreachable(value: never, context?: string): void {
	const label = context !== undefined ? `[${context}] ` : "";
	console.warn(`${label}Unhandled value: ${String(value)}`);
}
