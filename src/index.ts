import { platform } from "node:os";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "./acp/agent.js";

// Terminal Auth entrypoint: ACP client launches with `--terminal-login`.
if (process.argv.includes("--terminal-login")) {
	const { spawnSync } = await import("node:child_process");
	const isWindows = platform() === "win32";
	const cmd = process.env.PI_ACP_PI_COMMAND ?? (isWindows ? "pi.cmd" : "pi");
	const res = spawnSync(cmd, [], { stdio: "inherit", env: process.env });

	if (res.error && "code" in res.error && res.error.code === "ENOENT") {
		process.stderr.write(
			`pi-acp: could not start pi (command not found: ${cmd}). ` +
				"Install via `npm install -g @mariozechner/pi-coding-agent` " +
				"or ensure `pi` is on your PATH.\n",
		);
		process.exit(1);
	}

	process.exit(typeof res.status === "number" ? res.status : 1);
}

const input = new WritableStream<Uint8Array>({
	write(chunk) {
		return new Promise<void>((resolve) => {
			if (process.stdout.destroyed || !process.stdout.writable) {
				resolve();
				return;
			}
			try {
				process.stdout.write(chunk, () => resolve());
			} catch {
				resolve();
			}
		});
	},
});

const output = new ReadableStream<Uint8Array>({
	start(controller) {
		process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
		process.stdin.on("end", () => controller.close());
		process.stdin.on("error", (err) => controller.error(err));
	},
});

const stream = ndJsonStream(input, output);
const agent = new AgentSideConnection((conn) => new PiAcpAgent(conn), stream);

function shutdown() {
	try {
		// AgentSideConnection stores the agent instance internally;
		// call dispose() on it if available for clean shutdown.
		if ("agent" in agent) {
			const inner: unknown = agent.agent;
			if (
				typeof inner === "object" &&
				inner !== null &&
				"dispose" in inner &&
				typeof inner.dispose === "function"
			) {
				// eslint-disable-next-line typescript-eslint/no-unsafe-call -- runtime-guarded
				inner.dispose();
			}
		}
	} catch {
		// best-effort cleanup
	}
	process.exit(0);
}

process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.stdin.resume();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdout.on("error", () => process.exit(0));
