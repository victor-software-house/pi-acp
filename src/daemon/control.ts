/**
 * Daemon control plane: a Hono app served over a separate Unix domain socket
 * (`~/.pi/run/pi-acp-control.sock` by default).
 *
 * Operator clients (`pi-acp --daemon-status`, `pi-acp --daemon-stop`) talk to
 * this surface via HTTP-over-UDS. Keeping it out-of-band from the ACP NDJSON
 * socket means no first-frame peeking, no stream unshift dance — the ACP
 * accept path is pure ACP.
 *
 * Routes:
 *   GET  /status      → { uptimeSeconds, connections, sessions, pid, version }
 *   POST /shutdown    → triggers graceful shutdown (response sent first)
 *   GET  /sessions    → daemon session registry snapshot
 */

import type { DaemonContext } from "@pi-acp/daemon/context";
import { Hono } from "hono";

export interface ControlContext {
	ctx: DaemonContext;
	startedAt: number;
	pid: number;
	version: string;
	activeConnections: () => number;
	onShutdown: () => void;
}

export function buildControlApp(control: ControlContext): Hono {
	const app = new Hono();

	app.get("/status", (c) =>
		c.json({
			uptimeSeconds: Math.round((Date.now() - control.startedAt) / 1000),
			connections: control.activeConnections(),
			sessions: control.ctx.sessionRegistry.listAll().length,
			pid: control.pid,
			version: control.version,
		}),
	);

	app.post("/shutdown", (c) => {
		// Defer one tick so the response flushes before we tear the listener
		// down — otherwise the operator sees a connection reset instead of 200.
		setImmediate(control.onShutdown);
		return c.json({ ok: true });
	});

	app.get("/sessions", (c) =>
		c.json({
			sessions: control.ctx.sessionRegistry.listAll().map((entry) => ({
				sessionId: entry.sessionId,
				cwd: entry.cwd,
				owner: entry.ownerConnectionId,
				alsoHeldBy: [...entry.alsoHeldBy],
				updatedAt: entry.updatedAt,
			})),
		}),
	);

	return app;
}

export interface ControlServer {
	stop(): void;
}

/**
 * Bind the control app to a Unix domain socket. Uses Bun.serve's `unix` option.
 */
export function serveControl(app: Hono, socketPath: string): ControlServer {
	const server = Bun.serve({
		unix: socketPath,
		fetch: app.fetch,
	});
	return {
		stop() {
			try {
				void server.stop(true);
			} catch {
				/* best-effort */
			}
		},
	};
}
