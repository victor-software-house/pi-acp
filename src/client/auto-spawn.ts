import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { socketPath } from "@pi-acp/daemon/socket";

const POLL_INTERVAL_MS = 50;

export async function tryConnect(): Promise<Socket | null> {
	const path = socketPath();
	return await new Promise<Socket | null>((resolve) => {
		const sock = connect(path);
		const onConnect = (): void => {
			sock.off("error", onError);
			resolve(sock);
		};
		const onError = (): void => {
			sock.off("connect", onConnect);
			try {
				sock.destroy();
			} catch {
				/* best-effort */
			}
			resolve(null);
		};
		sock.once("connect", onConnect);
		sock.once("error", onError);
	});
}

export async function waitForSocket(timeoutMs: number): Promise<Socket | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const sock = await tryConnect();
		if (sock) return sock;
		await delay(POLL_INTERVAL_MS);
	}
	return null;
}

/**
 * Fork pi-acp --daemon detached so the daemon outlives this process.
 *
 * Note: we resolve the entry-point script via `process.argv[1]` so the same
 * bin / dev entry is reused without the client needing to know its own path.
 */
export function autoSpawnDaemon(): void {
	const entry = process.argv[1];
	if (entry === undefined) {
		throw new Error("pi-acp: cannot resolve entry script for daemon spawn");
	}
	const child = spawn(process.execPath, [entry, "--daemon"], {
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();
}
