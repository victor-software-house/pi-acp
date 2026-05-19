/**
 * Operator client modes: pi-acp --daemon-status, pi-acp --daemon-stop.
 *
 * Both connect to the daemon socket and send a `daemon/<method>` JSON-RPC
 * frame; the daemon handles them inline (see src/daemon/control.ts) before
 * the normal ACP handoff.
 */

import { tryConnect } from "@pi-acp/client/auto-spawn";

const CONTROL_TIMEOUT_MS = 5000;

export async function runDaemonStatus(): Promise<void> {
	const socket = await tryConnect();
	if (socket === null) {
		process.stderr.write("pi-acp daemon: not running\n");
		process.exit(1);
	}

	const id = 1;
	const frame = JSON.stringify({ jsonrpc: "2.0", id, method: "daemon/status" });
	socket.write(`${frame}\n`);

	const response = await readSingleFrame(socket);
	socket.destroy();

	if (response === null) {
		process.stderr.write("pi-acp daemon: no response\n");
		process.exit(1);
	}

	process.stdout.write(`${response}\n`);
	process.exit(0);
}

export async function runDaemonStop(): Promise<void> {
	const socket = await tryConnect();
	if (socket === null) {
		process.stderr.write("pi-acp daemon: not running\n");
		process.exit(0);
	}

	const id = 1;
	const frame = JSON.stringify({ jsonrpc: "2.0", id, method: "daemon/shutdown" });
	socket.write(`${frame}\n`);

	const response = await readSingleFrame(socket);
	if (response === null) {
		process.stderr.write("pi-acp daemon: no response (already exiting?)\n");
		process.exit(0);
	}

	// Wait for the socket to close, which signals daemon shutdown completed.
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, CONTROL_TIMEOUT_MS);
		timer.unref?.();
		socket.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});

	process.stderr.write("pi-acp daemon: stopped\n");
	process.exit(0);
}

async function readSingleFrame(socket: NodeJS.ReadableStream): Promise<string | null> {
	return new Promise((resolve) => {
		let buf = Buffer.alloc(0);
		const timer = setTimeout(() => {
			cleanup();
			resolve(null);
		}, CONTROL_TIMEOUT_MS);
		timer.unref?.();
		const cleanup = (): void => {
			clearTimeout(timer);
			socket.off("data", onData);
		};
		const onData = (chunk: Buffer): void => {
			buf = Buffer.concat([buf, chunk]);
			const idx = buf.indexOf(0x0a);
			if (idx === -1) return;
			cleanup();
			resolve(buf.subarray(0, idx).toString("utf8"));
		};
		socket.on("data", onData);
	});
}
