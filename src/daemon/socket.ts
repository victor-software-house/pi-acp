import {
	closeSync,
	constants as fsConstants,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * Per-UID socket path. Lives under XDG_RUNTIME_DIR (or TMPDIR) so it's bounded
 * to the user. Posix-only — Windows is not supported.
 */
export function socketPath(): string {
	const baseDir =
		process.env["PI_ACP_SOCKET_DIR"] ??
		process.env["XDG_RUNTIME_DIR"] ??
		process.env["TMPDIR"] ??
		tmpdir();
	const uid =
		typeof process.getuid === "function"
			? process.getuid()
			: userInfo().uid !== -1
				? userInfo().uid
				: 0;
	return join(baseDir, `pi-acp-${uid}.sock`);
}

export function lockfilePath(): string {
	return `${socketPath()}.lock`;
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

/**
 * Remove a socket file left behind by a dead daemon.
 */
export function removeStaleSocketIfAny(): void {
	const path = socketPath();
	try {
		statSync(path);
		unlinkSync(path);
	} catch {
		/* not present — fine */
	}
}

export function ensureSocketParentDir(): void {
	const dir = dirname(socketPath());
	try {
		statSync(dir);
	} catch {
		// Defer mkdir to the OS-default; if the parent is missing we surface
		// the error later at bind() rather than guessing at mode bits here.
	}
}
