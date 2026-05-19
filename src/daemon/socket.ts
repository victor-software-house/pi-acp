import {
	closeSync,
	constants as fsConstants,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Socket + lockfile live under ~/.pi/run/ by default so everything pi-related
 * stays under one tree. PI_ACP_SOCKET_DIR overrides for tests / sandboxing.
 */
function baseDir(): string {
	return process.env["PI_ACP_SOCKET_DIR"] ?? join(homedir(), ".pi", "run");
}

export function socketPath(): string {
	return join(baseDir(), "pi-acp.sock");
}

export function controlSocketPath(): string {
	return join(baseDir(), "pi-acp-control.sock");
}

export function lockfilePath(): string {
	return join(baseDir(), "pi-acp.lock");
}

function errnoCode(err: unknown): string | undefined {
	if (typeof err === "object" && err !== null && "code" in err) {
		const code = (err as { code: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = errnoCode(err);
		if (code === "EPERM") return true;
		return false;
	}
}

export interface LockAcquireResult {
	ok: boolean;
	heldByPid?: number;
}

/**
 * Acquire the daemon lockfile by writing our PID. If a lockfile already exists
 * and its PID is alive, refuse. If the PID is dead, reclaim.
 */
export function acquireLock(): LockAcquireResult {
	ensureSocketParentDir();
	const path = lockfilePath();
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(
				path,
				fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
				0o600,
			);
			try {
				writeFileSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			return { ok: true };
		} catch (err) {
			const code = errnoCode(err);
			if (code !== "EEXIST") throw err;
			const existing = readPidFromLockfile(path);
			if (existing !== undefined && pidIsAlive(existing)) {
				return { ok: false, heldByPid: existing };
			}
			try {
				unlinkSync(path);
			} catch {
				/* ignore — next attempt */
			}
		}
	}
	return { ok: false };
}

export function releaseLock(): void {
	try {
		unlinkSync(lockfilePath());
	} catch {
		/* ignore */
	}
}

function readPidFromLockfile(path: string): number | undefined {
	try {
		const raw = readFileSync(path, "utf8").trim();
		const n = Number.parseInt(raw, 10);
		return Number.isFinite(n) ? n : undefined;
	} catch {
		return undefined;
	}
}

function removeIfExists(path: string): void {
	try {
		statSync(path);
		unlinkSync(path);
	} catch {
		/* not present — fine */
	}
}

export function removeStaleSocketIfAny(): void {
	removeIfExists(socketPath());
	removeIfExists(controlSocketPath());
}

export function ensureSocketParentDir(): void {
	const dir = dirname(socketPath());
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (err) {
		if (errnoCode(err) !== "EEXIST") throw err;
	}
}
