import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
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
	const dir = mkdtempSync(join(tmpdir(), "pi-acp-daemon-test-"));
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const sock = join(dir, `pi-acp-${uid}.sock`);
	return { socketDir: dir, socketPath: sock, lockfilePath: `${sock}.lock` };
}

function teardownEnv(env: TestEnv): void {
	rmSync(env.socketDir, { recursive: true, force: true });
}

function spawnDaemon(env: TestEnv): ChildProcess {
	return spawn("bun", [ENTRY, "--daemon"], {
		stdio: "ignore",
		env: { ...process.env, PI_ACP_SOCKET_DIR: env.socketDir },
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

async function tryConnectSock(path: string, timeoutMs = 1500): Promise<Socket | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const sock = await new Promise<Socket | null>((resolve) => {
			const s = connect(path);
			s.once("connect", () => resolve(s));
			s.once("error", () => {
				s.destroy();
				resolve(null);
			});
		});
		if (sock) return sock;
		await delay(50);
	}
	return null;
}

async function sendInitRequest(sock: Socket): Promise<unknown> {
	return await new Promise((resolve, reject) => {
		const req = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1 },
		});
		const chunks: Buffer[] = [];
		const onData = (chunk: Buffer): void => {
			chunks.push(chunk);
			const text = Buffer.concat(chunks).toString("utf8");
			const newlineIdx = text.indexOf("\n");
			if (newlineIdx !== -1) {
				sock.off("data", onData);
				try {
					resolve(JSON.parse(text.slice(0, newlineIdx)));
				} catch (err) {
					reject(err);
				}
			}
		};
		sock.on("data", onData);
		sock.on("error", reject);
		sock.write(`${req}\n`);
	});
}

describe("daemon lifecycle", () => {
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

	test("daemon spawns, binds socket, writes lockfile, responds to initialize", async () => {
		daemon = spawnDaemon(env);
		const bound = await waitForSocket(env.socketPath, 3000);
		expect(bound).toBe(true);
		expect(existsSync(env.lockfilePath)).toBe(true);

		const sock = await tryConnectSock(env.socketPath);
		expect(sock).not.toBeNull();
		if (sock === null) return;

		const response = await sendInitRequest(sock);
		expect(response).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: { protocolVersion: 1 },
		});
		sock.destroy();
	});

	test("daemon refuses a second --daemon invocation while alive", async () => {
		daemon = spawnDaemon(env);
		await waitForSocket(env.socketPath, 3000);

		const second = spawn("bun", [ENTRY, "--daemon"], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_ACP_SOCKET_DIR: env.socketDir },
		});
		let stderr = "";
		second.stderr?.on("data", (c: Buffer) => {
			stderr += c.toString("utf8");
		});
		const exit = await new Promise<number | null>((resolve) => {
			second.on("exit", (code) => resolve(code));
		});
		expect(exit).toBe(1);
		expect(stderr).toContain("already running");
	});

	test("SIGTERM cleans up socket + lockfile", async () => {
		daemon = spawnDaemon(env);
		await waitForSocket(env.socketPath, 3000);
		daemon.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			daemon?.on("exit", () => resolve());
		});
		// Give the exit handler a tick to unlink files
		await delay(100);
		expect(existsSync(env.socketPath)).toBe(false);
		expect(existsSync(env.lockfilePath)).toBe(false);
	});
});
