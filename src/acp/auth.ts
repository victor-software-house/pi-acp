/**
 * Build ACP AuthMethod descriptors for terminal-based authentication.
 *
 * Supports both the registry-required "type/args/env" shape and Zed's
 * _meta["terminal-auth"] extension for the Authenticate banner.
 */

import type { AuthMethod } from "@agentclientprotocol/sdk";

export const AUTH_METHOD_ID = "pi_terminal_login";

interface AuthMethodOptions {
	supportsTerminalAuthMeta?: boolean;
}

export function buildAuthMethods(opts?: AuthMethodOptions): AuthMethod[] {
	const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true;

	const method: AuthMethod = {
		id: AUTH_METHOD_ID,
		name: "Launch pi in the terminal",
		description: "Start pi in an interactive terminal to configure API keys or login",
		type: "terminal",
		args: ["--terminal-login"],
		env: {},
	};

	if (supportsTerminalAuthMeta) {
		const launch = resolveTerminalLaunchCommand();
		method._meta = {
			"terminal-auth": {
				...launch,
				label: "Launch pi",
			},
		};
	}

	return [method];
}

function resolveTerminalLaunchCommand(): { command: string; args: string[] } {
	const argv0 = process.argv[0] ?? "node";
	const argv1 = process.argv[1];

	if (argv1 !== undefined && argv0.includes("node") && argv1.endsWith(".js")) {
		return { command: argv0, args: [argv1, "--terminal-login"] };
	}

	return { command: "pi-acp", args: ["--terminal-login"] };
}
