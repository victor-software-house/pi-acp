/**
 * pi-acp entry point. Dispatches between modes:
 *
 *   --terminal-login                    → foreground pi for interactive auth
 *   --daemon                            → long-running orchestrator (PRD-003)
 *   --daemon-status / --daemon-stop     → operator commands
 *   (default)                           → thin client; auto-spawns daemon
 *
 * ACP transports JSON-RPC NDJSON over stdout. Any stray byte poisons the
 * protocol stream. Redirect console.{log,info,warn,debug} to stderr at boot
 * so transitive deps (or our own debug prints) can't corrupt it.
 */

export {};

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
} else {
	const { runClient } = await import("@pi-acp/client/index");
	await runClient();
}

async function runTerminalLogin(): Promise<void> {
	const { spawnSync } = await import("node:child_process");
	const { piCliEntry } = await import("@pi-acp/pi-package");

	// Pi is a regular npm dependency, so we resolve its CLI through
	// node_modules instead of relying on `pi` being on PATH.
	const override = process.env["PI_ACP_PI_COMMAND"];
	const target =
		override !== undefined
			? { cmd: override, args: [] }
			: { cmd: process.execPath, args: [piCliEntry()] };

	const res = spawnSync(target.cmd, target.args, { stdio: "inherit", env: process.env });

	if (res.error && "code" in res.error && res.error.code === "ENOENT") {
		process.stderr.write(
			`pi-acp: could not start pi (command not found: ${target.cmd}). ` +
				"Reinstall pi-acp, or set PI_ACP_PI_COMMAND to point at a pi binary.\n",
		);
		process.exit(1);
	}

	process.exit(typeof res.status === "number" ? res.status : 1);
}
