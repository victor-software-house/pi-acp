/**
 * Model alias resolution for user-friendly model names.
 *
 * Lets users type "opus", "sonnet", "opus[1m]" instead of exact
 * "provider/modelId" strings. Uses tokenized matching and scoring
 * following the claude-agent-acp pattern.
 */

interface ModelEntry {
	provider: string;
	id: string;
	name?: string | undefined;
}

interface ResolvedModel {
	provider: string;
	id: string;
}

/**
 * Tokenize a string: split on non-alphanumeric, lowercase, strip "claude".
 */
function tokenize(input: string): string[] {
	return input
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t !== "" && t !== "claude");
}

/**
 * Extract a context hint in square brackets, e.g. "opus[1m]" -> { base: "opus", hint: "1m" }.
 */
function extractContextHint(input: string): { base: string; hint: string | null } {
	const match = /^(.+?)\[([^\]]+)\]$/.exec(input);
	if (match !== null && match[1] !== undefined && match[2] !== undefined) {
		return { base: match[1], hint: match[2] };
	}
	return { base: input, hint: null };
}

/** Check if a string is purely numeric. */
function isNumeric(s: string): boolean {
	return /^\d+$/.test(s);
}

/**
 * Score how well a model matches the given preference tokens.
 *
 * Returns a score >= 0 (higher is better), or -1 for no match.
 * Requires at least one non-numeric token to match to avoid false positives
 * from bare version numbers (e.g. "4" matching model version suffixes).
 */
function scoreModel(model: ModelEntry, prefTokens: string[], hint: string | null): number {
	const modelStr = `${model.provider}/${model.id}/${model.name ?? ""}`.toLowerCase();
	const modelTokens = tokenize(modelStr);

	let matched = 0;
	let hasNonNumericMatch = false;
	for (const pt of prefTokens) {
		if (modelTokens.some((mt) => mt.includes(pt) || pt.includes(mt))) {
			matched++;
			if (!isNumeric(pt)) hasNonNumericMatch = true;
		}
	}

	if (matched === 0) return -1;

	// Require at least one non-numeric token to match -- prevents "gpt-4"
	// matching on the bare "4" version component.
	if (!hasNonNumericMatch) return -1;

	let score = matched / prefTokens.length;

	// Bonus for hint match (e.g. "1m" context window hint)
	if (hint !== null && modelStr.includes(hint.toLowerCase())) {
		score += 0.5;
	}

	// Bonus for exact substring match on model id
	const pref = prefTokens.join("");
	if (model.id.toLowerCase().includes(pref)) {
		score += 0.25;
	}

	return score;
}

/**
 * Resolve a user-friendly model preference to a concrete model.
 *
 * Matching strategy (in order):
 * 1. Exact match on "provider/id"
 * 2. Exact match on "id" alone
 * 3. Tokenized scored match with optional context hint
 *
 * Returns null if no model matches.
 */
export function resolveModelPreference(
	models: readonly ModelEntry[],
	preference: string,
): ResolvedModel | null {
	const trimmed = preference.trim();
	if (trimmed === "") return null;

	// 1. Exact match on "provider/id"
	if (trimmed.includes("/")) {
		const [p, ...rest] = trimmed.split("/");
		const provider = p ?? "";
		const id = rest.join("/");
		const exact = models.find(
			(m) =>
				m.provider.toLowerCase() === provider.toLowerCase() &&
				m.id.toLowerCase() === id.toLowerCase(),
		);
		if (exact !== undefined) return { provider: exact.provider, id: exact.id };
	}

	// 2. Exact match on id alone
	const byId = models.find((m) => m.id.toLowerCase() === trimmed.toLowerCase());
	if (byId !== undefined) return { provider: byId.provider, id: byId.id };

	// 3. Tokenized scored match
	const { base, hint } = extractContextHint(trimmed);
	const prefTokens = tokenize(base);
	if (prefTokens.length === 0) return null;

	let bestModel: ModelEntry | null = null;
	let bestScore = -1;

	for (const model of models) {
		const s = scoreModel(model, prefTokens, hint);
		if (s > bestScore) {
			bestScore = s;
			bestModel = model;
		}
	}

	// Require at least 50% of preference tokens to match to avoid spurious hits
	// (e.g. "gpt-4" matching on the "4" token alone)
	if (bestModel === null || bestScore < 0.5) return null;
	return { provider: bestModel.provider, id: bestModel.id };
}
