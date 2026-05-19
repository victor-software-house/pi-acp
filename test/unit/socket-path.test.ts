import { describe, expect, test } from "bun:test";
import { lockfilePath, socketPath } from "@pi-acp/daemon/socket";

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
			const path = socketPath();
			expect(path.startsWith("/tmp/test-pi-acp/")).toBe(true);
			expect(path.endsWith(".sock")).toBe(true);
		} finally {
			restoreEnv("PI_ACP_SOCKET_DIR", prev);
		}
	});

	test("falls back to XDG_RUNTIME_DIR when override absent", () => {
		const prevOverride = process.env["PI_ACP_SOCKET_DIR"];
		const prevXdg = process.env["XDG_RUNTIME_DIR"];
		restoreEnv("PI_ACP_SOCKET_DIR", undefined);
		process.env["XDG_RUNTIME_DIR"] = "/tmp/xdg-test";
		try {
			const path = socketPath();
			expect(path.startsWith("/tmp/xdg-test/")).toBe(true);
		} finally {
			restoreEnv("PI_ACP_SOCKET_DIR", prevOverride);
			restoreEnv("XDG_RUNTIME_DIR", prevXdg);
		}
	});

	test("socket basename includes uid for per-user scoping", () => {
		const path = socketPath();
		const uid = typeof process.getuid === "function" ? process.getuid() : 0;
		expect(path).toContain(`pi-acp-${uid}`);
	});

	test("lockfilePath is socket path with .lock suffix", () => {
		const sock = socketPath();
		const lock = lockfilePath();
		expect(lock).toBe(`${sock}.lock`);
	});
});
