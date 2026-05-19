/**
 * pi-acp entry point. Dispatches between four modes:
 *
 *   --terminal-login                    → foreground pi for interactive auth (v0.5 flow)
 *   --daemon                            → long-running orchestrator (PRD-003)
 *   --no-daemon | PI_ACP_NO_DAEMON=1    → v0.5 in-process server (escape hatch)
 *   (default)                           → thin client; auto-spawns daemon
 *
 * ACP transports JSON-RPC NDJSON over stdout. Any stray byte poisons the
 * protocol stream. Redirect console.{log,info,warn,debug} to stderr at boot
 * so transitive deps (or our own debug prints) can't corrupt it.
 */

import { platform } from "node:os";

{
	const toStderr = (...args: unknown[]): void => {
		process.stderr.write(
			`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
		);
	};
	console.log = toStderr;
	console.info = toStderr;
	console.warn = toStderr;
	console.debug = toStderr;
}

const argv = process.argv.slice(2);

if (argv.includes("--terminal-login")) {
	await runTerminalLogin();
} else if (argv.includes("--daemon")) {
	const { runDaemon } = await import("@pi-acp/daemon/index");
	await runDaemon();
} else if (argv.includes("--daemon-status")) {
	const { runDaemonStatus } = await import("@pi-acp/client/operator");
	await runDaemonStatus();
} else if (argv.includes("--daemon-stop")) {
	const { runDaemonStop } = await import("@pi-acp/client/operator");
	await runDaemonStop();
} else if (argv.includes("--no-daemon") || process.env["PI_ACP_NO_DAEMON"] === "1") {
	const { runInProcess } = await import("@pi-acp/runtime/in-process");
	runInProcess();
} else {
	const { runClient } = await import("@pi-acp/client/index");
	await runClient();
}

async function runTerminalLogin(): Promise<void> {
	const { spawnSync } = await import("node:child_process");
	const isWindows = platform() === "win32";
	const cmd = process.env["PI_ACP_PI_COMMAND"] ?? (isWindows ? "pi.cmd" : "pi");
	const res = spawnSync(cmd, [], { stdio: "inherit", env: process.env });

	if (res.error && "code" in res.error && res.error.code === "ENOENT") {
		process.stderr.write(
			`pi-acp: could not start pi (command not found: ${cmd}). ` +
				"Install via `npm install -g @earendil-works/pi-coding-agent` " +
				"or ensure `pi` is on your PATH.\n",
		);
		process.exit(1);
	}

	process.exit(typeof res.status === "number" ? res.status : 1);
}
