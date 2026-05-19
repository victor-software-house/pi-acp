/**
 * Parse and represent client capabilities from the ACP initialize request.
 *
 * Both reference implementations (claude-agent-acp, codex-acp) store and
 * use `clientCapabilities` for feature detection and auth method selection.
 *
 * Reads from:
 * - `_meta.terminal_output` — terminal output rendering
 * - `_meta.terminal-auth`   — terminal auth with command metadata
 * - `auth._meta.gateway`    — gateway auth (non-standard extension)
 * - `fs.readTextFile`       — typed spec-stable surface (PRD-002 §FR-6)
 */

import type { ClientCapabilities } from "@agentclientprotocol/sdk";

export interface ClientCapabilityFlags {
	/** Client supports terminal output metadata (info/output/exit lifecycle). */
	terminalOutput: boolean;
	/** Client supports terminal-based authentication with command metadata. */
	terminalAuth: boolean;
	/** Client supports gateway-based authentication. */
	gatewayAuth: boolean;
	/** Client supports `fs/read_text_file` requests (PRD-002 §FR-6). */
	fsReadTextFile: boolean;
}

export function parseClientCapabilities(
	caps: ClientCapabilities | undefined | null,
): ClientCapabilityFlags {
	// Single code path: treat null/undefined as an empty capabilities object.
	// Each flag's check is the source of truth for both the present and
	// absent cases — no parallel default branch to drift out of sync when
	// adding a new flag.
	const safe = caps ?? ({} as ClientCapabilities);

	const meta = safe._meta;
	const metaIsObject = typeof meta === "object" && meta !== null;

	const authMeta =
		"auth" in safe && typeof safe.auth === "object" && safe.auth !== null && "_meta" in safe.auth
			? safe.auth._meta
			: undefined;
	const authMetaIsObject = typeof authMeta === "object" && authMeta !== null;

	// biome-ignore lint/complexity/useLiteralKeys: tsc strict-mode index-signature access
	return {
		terminalOutput: metaIsObject && meta["terminal_output"] === true,
		terminalAuth: metaIsObject && meta["terminal-auth"] === true,
		gatewayAuth: authMetaIsObject && authMeta["gateway"] === true,
		fsReadTextFile: safe.fs?.readTextFile === true,
	};
}
