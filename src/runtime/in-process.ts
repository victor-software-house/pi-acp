/**
 * In-process ACP server. The v0.5 codepath, preserved as the `PI_ACP_NO_DAEMON`
 * escape hatch and reused by the daemon's own stdio-bridge fallback.
 *
 * Treats process.stdin/stdout as the ACP transport. Owns the shutdown
 * lifecycle (AgentSideConnection.closed + SIGINT/SIGTERM).
 */

import { serveAcp } from "@pi-acp/runtime/serve";

export function runInProcess(): void {
	const handle = serveAcp({
		input: process.stdin,
		output: process.stdout,
		// No DaemonContext: behavior identical to v0.5.
	});

	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		handle.dispose();
		process.exit(0);
	};

	void handle.connection.closed.then(shutdown);

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.stdout.on("error", () => process.exit(0));
}
