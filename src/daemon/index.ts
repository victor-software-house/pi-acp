/**
 * Daemon entry point. Invoked when pi-acp is launched with `--daemon`.
 *
 * Lifecycle:
 *   1. Acquire per-UID lockfile (refuses if another daemon alive).
 *   2. Remove stale socket file if any (left by a dead prior daemon).
 *   3. Construct DaemonContext shared singletons (Phase 1: stubs).
 *   4. Bind socket; accept loop spawns a per-connection serveAcp instance.
 *   5. SIGINT / SIGTERM → graceful shutdown.
 */

import { createServer, type Server, type Socket } from "node:net";
import { createDaemonContext, type DaemonContext } from "@pi-acp/daemon/context";
import {
	acquireLock,
	ensureSocketParentDir,
	releaseLock,
	removeStaleSocketIfAny,
	socketPath,
} from "@pi-acp/daemon/socket";
import { type ServeHandle, serveAcp } from "@pi-acp/runtime/serve";

interface Connection {
	socket: Socket;
	handle: ServeHandle;
}

export async function runDaemon(): Promise<void> {
	const lockResult = acquireLock();
	if (!lockResult.ok) {
		process.stderr.write(
			`pi-acp daemon: already running (pid ${lockResult.heldByPid ?? "unknown"})\n`,
		);
		process.exit(1);
	}

	ensureSocketParentDir();
	removeStaleSocketIfAny();

	const ctx: DaemonContext = createDaemonContext();
	const connections = new Set<Connection>();
	let shuttingDown = false;

	const server: Server = createServer((socket) => {
		if (shuttingDown) {
			socket.destroy();
			return;
		}
		const handle = serveAcp({ input: socket, output: socket, daemonContext: ctx });
		const entry: Connection = { socket, handle };
		connections.add(entry);
		ctx.idleTracker.bump(1);

		const cleanup = (): void => {
			if (!connections.delete(entry)) return;
			try {
				handle.dispose();
			} catch {
				/* best-effort */
			}
			ctx.idleTracker.bump(-1);
		};

		socket.on("close", cleanup);
		socket.on("error", cleanup);
	});

	server.on("error", (err) => {
		process.stderr.write(`pi-acp daemon: server error: ${err.message}\n`);
	});

	await new Promise<void>((resolve, reject) => {
		const path = socketPath();
		server.listen(path, () => resolve());
		server.once("error", reject);
	});

	if (process.env["PI_ACP_DAEMON_DEBUG"] === "1") {
		process.stderr.write(`pi-acp daemon: listening on ${socketPath()} (pid ${process.pid})\n`);
	}

	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		server.close();
		for (const entry of connections) {
			try {
				entry.handle.dispose();
			} catch {
				/* best-effort */
			}
			try {
				entry.socket.destroy();
			} catch {
				/* best-effort */
			}
		}
		connections.clear();
		ctx.idleTracker.dispose();
		removeStaleSocketIfAny();
		releaseLock();
		process.exit(0);
	};

	process.on("SIGINT", () => {
		void shutdown();
	});
	process.on("SIGTERM", () => {
		void shutdown();
	});
}
