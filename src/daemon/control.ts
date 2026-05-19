import type { Socket } from "node:net";
import type { DaemonContext } from "@pi-acp/daemon/context";

/**
 * Daemon control-frame protocol (in-band on the same socket).
 *
 * Methods recognized BEFORE the ACP handoff:
 *   - `daemon/status` — returns runtime info (uptime, connection count,
 *     session count, pid, version).
 *   - `daemon/shutdown` — graceful shutdown.
 *
 * The first newline-terminated frame received on a new socket is sniffed
 * for these method names. Anything else hands the socket to the normal
 * ACP serve path.
 */

export interface ControlPeekResult {
	kind: "control" | "passthrough";
	method?: "daemon/status" | "daemon/shutdown";
	id?: number | string | null;
	buffered: Buffer;
}

export interface ControlContext {
	ctx: DaemonContext;
	startedAt: number;
	pid: number;
	version: string;
	activeConnections: () => number;
}

const FIRST_FRAME_TIMEOUT_MS = 200;

function readMethod(parsed: unknown): "daemon/status" | "daemon/shutdown" | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const raw: unknown = Reflect.get(parsed, "method");
	if (raw === "daemon/status") return "daemon/status";
	if (raw === "daemon/shutdown") return "daemon/shutdown";
	return null;
}

function readId(parsed: unknown): number | string | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const raw: unknown = Reflect.get(parsed, "id");
	if (typeof raw === "number") return raw;
	if (typeof raw === "string") return raw;
	return null;
}

export async function peekFirstFrame(socket: Socket): Promise<ControlPeekResult> {
	return new Promise((resolve) => {
		let buf = Buffer.alloc(0);
		let done = false;

		const finish = (result: ControlPeekResult): void => {
			if (done) return;
			done = true;
			socket.off("data", onData);
			clearTimeout(timer);
			resolve(result);
		};

		const onData = (chunk: Buffer): void => {
			buf = Buffer.concat([buf, chunk]);
			const idx = buf.indexOf(0x0a);
			if (idx === -1) return;
			const line = buf.subarray(0, idx).toString("utf8");
			try {
				const parsed: unknown = JSON.parse(line);
				const method = readMethod(parsed);
				if (method !== null) {
					const id = readId(parsed);
					finish({ kind: "control", method, id, buffered: buf });
					return;
				}
			} catch {
				// Not valid JSON — let ACP framing handle it.
			}
			finish({ kind: "passthrough", buffered: buf });
		};

		// If we get nothing in 200ms, treat as ACP passthrough — the client
		// may be slow to send the first frame (acceptable; ACP servers idle).
		const timer = setTimeout(
			() => finish({ kind: "passthrough", buffered: buf }),
			FIRST_FRAME_TIMEOUT_MS,
		);
		timer.unref?.();

		socket.on("data", onData);
	});
}

export function handleStatus(
	socket: Socket,
	id: number | string | null,
	control: ControlContext,
): void {
	const uptimeSeconds = Math.round((Date.now() - control.startedAt) / 1000);
	const response = {
		jsonrpc: "2.0",
		id,
		result: {
			uptimeSeconds,
			connections: control.activeConnections(),
			sessions: control.ctx.sessionRegistry.listAll().length,
			pid: control.pid,
			version: control.version,
		},
	};
	socket.write(`${JSON.stringify(response)}\n`);
	socket.end();
}

export function handleShutdown(
	socket: Socket,
	id: number | string | null,
	onShutdown: () => void,
): void {
	const response = { jsonrpc: "2.0", id, result: {} };
	socket.write(`${JSON.stringify(response)}\n`, () => {
		socket.end();
		// Defer one tick so the response is flushed before we tear the
		// listener down.
		setImmediate(onShutdown);
	});
}
