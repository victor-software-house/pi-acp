/**
 * Daemon entry point. Invoked when pi-acp is launched with `--daemon`.
 *
 * Lifecycle:
 *   1. Acquire per-UID lockfile (refuses if another daemon alive).
 *   2. Remove stale socket files left by a dead prior daemon.
 *   3. Construct DaemonContext shared singletons.
 *   4. Bind ACP socket (raw NDJSON via node:net).
 *   5. Bind control socket (HTTP via Bun.serve + Hono).
 *   6. SIGINT/SIGTERM/idle-timeout trigger graceful shutdown.
 */

import { createServer, type Server, type Socket } from "node:net";
import { createDaemonContext, type DaemonContext } from "@pi-acp/daemon/context";
import {
	buildControlApp,
	type ControlContext,
	type ControlServer,
	serveControl,
} from "@pi-acp/daemon/control";
import { createIdleTracker, resolveIdleMs } from "@pi-acp/daemon/idle";
import {
	acquireLock,
	controlSocketPath,
	ensureSocketParentDir,
	releaseLock,
	removeStaleSocketIfAny,
	socketPath,
} from "@pi-acp/daemon/socket";
import { type ServeHandle, serveAcp } from "@pi-acp/runtime/serve";

import pkgJson from "../../package.json" with { type: "json" };

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

	const connections = new Set<Connection>();
	let shuttingDown = false;
	const startedAt = Date.now();

	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		server.close();
		controlServer.stop();
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

	const ctx: DaemonContext = createDaemonContext();
	ctx.idleTracker = createIdleTracker({ idleMs: resolveIdleMs(), onIdle: shutdown });

	const controlCtx: ControlContext = {
		ctx,
		startedAt,
		pid: process.pid,
		version: pkgJson.version,
		activeConnections: () => connections.size,
		onShutdown: shutdown,
	};

	const server: Server = createServer((socket) => {
		if (shuttingDown) {
			socket.destroy();
			return;
		}
		onAccept(socket);
	});

	const onAccept = (socket: Socket): void => {
		const handle = serveAcp({
			input: socket,
			output: socket,
			daemonContext: ctx,
		});
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
	};

	server.on("error", (err) => {
		process.stderr.write(`pi-acp daemon: server error: ${err.message}\n`);
	});

	await new Promise<void>((resolve, reject) => {
		const path = socketPath();
		server.listen(path, () => resolve());
		server.once("error", reject);
	});

	const controlServer: ControlServer = serveControl(
		buildControlApp(controlCtx),
		controlSocketPath(),
	);

	// biome-ignore lint/complexity/useLiteralKeys: env var keys need bracket access for tsc strict mode
	if (process.env["PI_ACP_DAEMON_DEBUG"] === "1") {
		process.stderr.write(
			`pi-acp daemon: acp=${socketPath()} control=${controlSocketPath()} pid=${process.pid}\n`,
		);
	}

	process.on("SIGINT", () => {
		shutdown();
	});
	process.on("SIGTERM", () => {
		shutdown();
	});
}
