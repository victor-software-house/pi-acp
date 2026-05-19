/**
 * ACP-over-stream wiring for the daemon's per-connection accept path.
 *
 * Owns nothing global. Returns the constructed AgentSideConnection plus a
 * shutdown helper. Caller decides what process / signal handlers to attach.
 */

import type { Duplex } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "@pi-acp/acp/agent";
import type { DaemonContext } from "@pi-acp/daemon/context";

export interface ServeOptions {
	/** Reads from the client. */
	input: Duplex;
	/** Writes to the client. */
	output: Duplex;
	daemonContext: DaemonContext;
}

export interface ServeHandle {
	connection: AgentSideConnection;
	/** Best-effort dispose of the PiAcpAgent. */
	dispose: () => void;
}

export function serveAcp(opts: ServeOptions): ServeHandle {
	// Build the NDJSON framing layer. `input` is the client-bound stream we
	// read FROM (client → agent). `output` is the stream we write TO
	// (agent → client). ndJsonStream(writable, readable): first arg is where
	// the agent writes responses, second is where it reads requests.
	const stream = ndJsonStream(toWebWritable(opts.output), toWebReadable(opts.input));
	const connection = new AgentSideConnection(
		(conn) => new PiAcpAgent(conn, opts.daemonContext),
		stream,
	);
	return {
		connection,
		dispose() {
			try {
				const inner = readUnknownProp(connection, "agent");
				const dispose = readUnknownProp(inner, "dispose");
				if (typeof dispose === "function") {
					Reflect.apply(dispose, inner, []);
				}
			} catch {
				/* best-effort */
			}
		},
	};
}

function readUnknownProp(target: unknown, key: string): unknown {
	if (typeof target !== "object" || target === null) return undefined;
	return Reflect.get(target, key);
}

function toWebReadable(src: Duplex): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			src.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
			src.on("end", () => {
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
			src.on("error", (err) => {
				try {
					controller.error(err);
				} catch {
					/* already terminated */
				}
			});
		},
	});
}

function toWebWritable(dst: Duplex): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise<void>((resolve) => {
				if (dst.destroyed || !dst.writable) {
					resolve();
					return;
				}
				try {
					dst.write(chunk, () => resolve());
				} catch {
					resolve();
				}
			});
		},
	});
}
