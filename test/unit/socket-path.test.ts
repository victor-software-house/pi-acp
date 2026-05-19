import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { controlSocketPath, lockfilePath, socketPath } from "@pi-acp/daemon/socket";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, key);
	} else {
		process.env[key] = value;
	}
}

describe("socket path resolution", () => {
	test("uses PI_ACP_SOCKET_DIR when set", () => {
		const prev = process.env["PI_ACP_SOCKET_DIR"];
		process.env["PI_ACP_SOCKET_DIR"] = "/tmp/test-pi-acp";
		try {
			expect(socketPath()).toBe("/tmp/test-pi-acp/pi-acp.sock");
			expect(controlSocketPath()).toBe("/tmp/test-pi-acp/pi-acp-control.sock");
			expect(lockfilePath()).toBe("/tmp/test-pi-acp/pi-acp.lock");
		} finally {
			restoreEnv("PI_ACP_SOCKET_DIR", prev);
		}
	});

	test("defaults to ~/.pi/run/ when override absent", () => {
		const prev = process.env["PI_ACP_SOCKET_DIR"];
		restoreEnv("PI_ACP_SOCKET_DIR", undefined);
		try {
			expect(socketPath()).toBe(join(homedir(), ".pi", "run", "pi-acp.sock"));
			expect(controlSocketPath()).toBe(join(homedir(), ".pi", "run", "pi-acp-control.sock"));
		} finally {
			restoreEnv("PI_ACP_SOCKET_DIR", prev);
		}
	});

	test("lockfile is sibling of socket", () => {
		const sock = socketPath();
		const lock = lockfilePath();
		expect(lock).toBe(sock.replace(/\.sock$/, ".lock"));
	});
});
