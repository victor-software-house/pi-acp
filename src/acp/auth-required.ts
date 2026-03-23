/**
 * Detect common auth/credential errors from pi and surface them as ACP AUTH_REQUIRED.
 */

import { RequestError } from "@agentclientprotocol/sdk";
import { buildAuthMethods } from "@pi-acp/acp/auth.js";

const AUTH_ERROR_PATTERNS = [
	"api key",
	"apikey",
	"missing key",
	"no key",
	"not configured",
	"unauthorized",
	"authentication",
	"permission denied",
	"forbidden",
	"401",
	"403",
];

export function detectAuthError(err: unknown): RequestError | null {
	const text = err instanceof Error ? err.message : String(err ?? "");
	const lower = text.toLowerCase();

	const isAuthRelated = AUTH_ERROR_PATTERNS.some((p) => lower.includes(p));
	if (!isAuthRelated) return null;

	return RequestError.authRequired(
		{ authMethods: buildAuthMethods() },
		"Configure an API key or log in with an OAuth provider.",
	);
}
