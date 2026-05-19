/**
 * Operator client modes: pi-acp --daemon-status, pi-acp --daemon-stop.
 *
 * Talks to the daemon's control plane (Hono over Unix-domain HTTP) using
 * Bun.fetch's `unix` option. The control socket is separate from the ACP
 * socket, so these commands never disturb live ACP traffic.
 */

import { existsSync } from "node:fs";
import { controlSocketPath } from "@pi-acp/daemon/socket";

const CONTROL_TIMEOUT_MS = 5000;

async function controlFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
	const sock = controlSocketPath();
	if (!existsSync(sock)) return null;
	try {
		return await Bun.fetch(`http://daemon${path}`, {
			...init,
			unix: sock,
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
}

export async function runDaemonStatus(): Promise<void> {
	const res = await controlFetch("/status");
	if (res === null) {
		process.stderr.write("pi-acp daemon: not running\n");
		process.exit(1);
	}
	const body = await res.text();
	process.stdout.write(`${body}\n`);
	process.exit(0);
}

export async function runDaemonStop(): Promise<void> {
	const res = await controlFetch("/shutdown", { method: "POST" });
	if (res === null) {
		process.stderr.write("pi-acp daemon: not running\n");
		process.exit(0);
	}
	if (!res.ok) {
		process.stderr.write(`pi-acp daemon: shutdown failed (HTTP ${res.status})\n`);
		process.exit(1);
	}
	process.stderr.write("pi-acp daemon: stopped\n");
	process.exit(0);
}
