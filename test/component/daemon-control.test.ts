import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

interface TestEnv {
	socketDir: string;
	socketPath: string;
	lockfilePath: string;
}

function setupEnv(): TestEnv {
	const dir = mkdtempSync(join(tmpdir(), "pi-acp-control-test-"));
	const sock = join(dir, "pi-acp.sock");
	const lock = join(dir, "pi-acp.lock");
	return { socketDir: dir, socketPath: sock, lockfilePath: lock };
}

function teardownEnv(env: TestEnv): void {
	rmSync(env.socketDir, { recursive: true, force: true });
}

function spawnDaemon(env: TestEnv, extraEnv: Record<string, string> = {}): ChildProcess {
	return spawn("bun", [ENTRY, "--daemon"], {
		stdio: "ignore",
		env: { ...process.env, PI_ACP_SOCKET_DIR: env.socketDir, ...extraEnv },
	});
}

async function waitForSocket(path: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await delay(50);
	}
	return false;
}

describe("daemon control commands", () => {
	let env: TestEnv;
	let daemon: ChildProcess | null;

	beforeEach(() => {
		env = setupEnv();
		daemon = null;
	});

	afterEach(async () => {
		if (daemon !== null && daemon.exitCode === null) {
			daemon.kill("SIGTERM");
			await delay(150);
			if (daemon.exitCode === null) daemon.kill("SIGKILL");
		}
		teardownEnv(env);
	});

	test("--daemon-status with no daemon exits 1 with stderr message", () => {
		const res = spawnSync("bun", [ENTRY, "--daemon-status"], {
			env: { ...process.env, PI_ACP_SOCKET_DIR: env.socketDir },
		});
		expect(res.status).toBe(1);
		expect(res.stderr.toString()).toContain("not running");
	});

	test("--daemon-status with running daemon returns JSON with pid + uptime", async () => {
		daemon = spawnDaemon(env, { PI_ACP_DAEMON_IDLE_SECONDS: "3600" });
		await waitForSocket(env.socketPath, 3000);

		const res = spawnSync("bun", [ENTRY, "--daemon-status"], {
			env: { ...process.env, PI_ACP_SOCKET_DIR: env.socketDir },
		});
		expect(res.status).toBe(0);
		const parsed = JSON.parse(res.stdout.toString()) as {
			pid: number;
			uptimeSeconds: number;
			version: string;
			connections: number;
			sessions: number;
		};
		expect(parsed.pid).toBe(daemon.pid ?? -1);
		expect(typeof parsed.uptimeSeconds).toBe("number");
		expect(typeof parsed.version).toBe("string");
		expect(typeof parsed.connections).toBe("number");
		expect(typeof parsed.sessions).toBe("number");
	});

	test("--daemon-stop with running daemon triggers shutdown", async () => {
		daemon = spawnDaemon(env, { PI_ACP_DAEMON_IDLE_SECONDS: "3600" });
		await waitForSocket(env.socketPath, 3000);

		const res = spawnSync("bun", [ENTRY, "--daemon-stop"], {
			env: { ...process.env, PI_ACP_SOCKET_DIR: env.socketDir },
		});
		expect(res.status).toBe(0);
		expect(res.stderr.toString()).toContain("stopped");

		await delay(200);
		expect(existsSync(env.socketPath)).toBe(false);
		expect(existsSync(env.lockfilePath)).toBe(false);
	});

	test("--daemon-stop with no daemon exits 0 with stderr message", () => {
		const res = spawnSync("bun", [ENTRY, "--daemon-stop"], {
			env: { ...process.env, PI_ACP_SOCKET_DIR: env.socketDir },
		});
		expect(res.status).toBe(0);
		expect(res.stderr.toString()).toContain("not running");
	});

	test("idle shutdown fires after PI_ACP_DAEMON_IDLE_SECONDS with no connections", async () => {
		daemon = spawnDaemon(env, { PI_ACP_DAEMON_IDLE_SECONDS: "1" });
		await waitForSocket(env.socketPath, 3000);
		expect(existsSync(env.socketPath)).toBe(true);

		await delay(2000);
		expect(existsSync(env.socketPath)).toBe(false);
		expect(existsSync(env.lockfilePath)).toBe(false);
	});
});
