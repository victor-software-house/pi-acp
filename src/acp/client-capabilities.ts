/**
 * Parse and represent client capabilities from the ACP initialize request.
 *
 * Both reference implementations (claude-agent-acp, codex-acp) store and
 * use `clientCapabilities` for feature detection and auth method selection.
 */

import type { ClientCapabilities } from "@agentclientprotocol/sdk";

export interface ClientCapabilityFlags {
	/** Client supports terminal output metadata (info/output/exit lifecycle). */
	terminalOutput: boolean;
	/** Client supports terminal-based authentication with command metadata. */
	terminalAuth: boolean;
	/** Client supports gateway-based authentication. */
	gatewayAuth: boolean;
}

/**
 * Extract well-known capability flags from ACP `ClientCapabilities`.
 *
 * Reads from:
 * - `_meta.terminal_output` (terminal output rendering)
 * - `_meta.terminal-auth` (terminal auth with command metadata)
 * - `auth._meta.gateway` (gateway auth, future use)
 */
export function parseClientCapabilities(
	caps: ClientCapabilities | undefined | null,
): ClientCapabilityFlags {
	if (caps === undefined || caps === null) {
		return { terminalOutput: false, terminalAuth: false, gatewayAuth: false };
	}

	// _meta is an optional declared property, safe to access with dot
	const meta = caps._meta;
	const terminalOutput =
		typeof meta === "object" && meta !== null && meta["terminal_output"] === true;
	const terminalAuth = typeof meta === "object" && meta !== null && meta["terminal-auth"] === true;

	// gateway auth lives under auth._meta.gateway (non-standard extension)
	let gatewayAuth = false;
	if ("auth" in caps) {
		const auth = caps.auth;
		if (typeof auth === "object" && auth !== null && "_meta" in auth) {
			const authMeta = auth._meta;
			if (typeof authMeta === "object" && authMeta !== null && "gateway" in authMeta) {
				gatewayAuth = authMeta["gateway"] === true;
			}
		}
	}

	return { terminalOutput, terminalAuth, gatewayAuth };
}
