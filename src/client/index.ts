/**
 * Thin-client entry point. Connects to (or auto-spawns) the daemon, then
 * forwards stdio in both directions.
 */

import type { Socket } from "node:net";
import { autoSpawnDaemon, tryConnect, waitForSocket } from "@pi-acp/client/auto-spawn";

const CONNECT_TIMEOUT_MS = 3000;

export async function runClient(): Promise<void> {
	let socket: Socket | null = await tryConnect();
	if (socket === null) {
		autoSpawnDaemon();
		socket = await waitForSocket(CONNECT_TIMEOUT_MS);
	}
	if (socket === null) {
		process.stderr.write(
			"pi-acp: failed to connect to daemon socket within 3s. Try `pi-acp --daemon` manually or set PI_ACP_NO_DAEMON=1.\n",
		);
		process.exit(1);
	}

	// Wire both pipes synchronously before yielding. The daemon won't send
	// frames until it receives an initialize request, so there's no window
	// where socket->stdout drops bytes — but don't reorder these.
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);

	let exiting = false;
	const exitOnce = (code: number): void => {
		if (exiting) return;
		exiting = true;
		process.exit(code);
	};

	socket.on("close", () => exitOnce(0));
	socket.on("error", (err) => {
		process.stderr.write(`pi-acp: socket error: ${err.message}\n`);
		exitOnce(1);
	});
	process.on("SIGINT", () => socket?.destroy());
	process.on("SIGTERM", () => socket?.destroy());
	process.stdout.on("error", () => exitOnce(0));
}
