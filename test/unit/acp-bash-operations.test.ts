/**
 * createAcpBashOperations: ACP terminal-backed BashOperations for pi's bash tool.
 * Tests stub AgentSideConnection.createTerminal + TerminalHandle methods and
 * assert command routing, output streaming via onData, sessionId late-binding,
 * cancellation via signal, and timeout-then-kill semantics.
 */

import { describe, expect, test } from "bun:test";

import { createAcpBashOperations } from "@pi-acp/acp/acp-bash-operations";

interface CreateCall {
	sessionId: string;
	command: string;
	args?: string[];
	cwd?: string | null;
	env?: Array<{ name: string; value: string }>;
}

interface StubTerminalOpts {
	outputs: string[]; // snapshots returned by successive currentOutput() calls
	exitCode: number | null;
	exitDelayMs?: number;
	killable?: boolean;
}

function makeStubConn(termOpts: StubTerminalOpts): {
	conn: Parameters<typeof createAcpBashOperations>[0]["conn"];
	creates: CreateCall[];
	released: boolean;
	killed: boolean;
} {
	const creates: CreateCall[] = [];
	let snapIdx = 0;
	let released = false;
	let killed = false;
	let exited = false;
	let resolveExit!: (value: { exitCode: number | null }) => void;
	const exitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
		resolveExit = resolve;
	});
	const exitTimer = setTimeout(() => {
		exited = true;
		resolveExit({ exitCode: termOpts.exitCode });
	}, termOpts.exitDelayMs ?? 50);

	const conn = {
		async createTerminal(params: CreateCall) {
			creates.push(params);
			return {
				id: "term-1",
				async currentOutput() {
					const out = termOpts.outputs[Math.min(snapIdx, termOpts.outputs.length - 1)] ?? "";
					snapIdx++;
					return {
						output: out,
						truncated: false,
						exitStatus: exited ? { exitCode: termOpts.exitCode } : null,
					};
				},
				async waitForExit() {
					return exitPromise;
				},
				async kill() {
					if (termOpts.killable === false) {
						throw new Error("kill not supported");
					}
					killed = true;
					exited = true;
					clearTimeout(exitTimer);
					// Real ACP terminals resolve waitForExit() once kill takes effect.
					resolveExit({ exitCode: null });
					return {};
				},
				async release() {
					released = true;
					return {};
				},
			};
		},
	} as unknown as Parameters<typeof createAcpBashOperations>[0]["conn"];

	return {
		conn,
		creates,
		get released() {
			return released;
		},
		get killed() {
			return killed;
		},
	};
}

describe("createAcpBashOperations.exec", () => {
	test("wraps command in /bin/sh -c and routes through createTerminal", async () => {
		const stub = makeStubConn({ outputs: ["hello\n"], exitCode: 0 });
		const ops = createAcpBashOperations({ conn: stub.conn, getSessionId: () => "sess-1" });
		const chunks: Buffer[] = [];
		const result = await ops.exec("echo hello", "/tmp", {
			onData: (b) => {
				chunks.push(b);
			},
		});
		expect(result.exitCode).toBe(0);
		expect(stub.creates).toHaveLength(1);
		expect(stub.creates[0]?.command).toBe("/bin/sh");
		expect(stub.creates[0]?.args).toEqual(["-c", "echo hello"]);
		expect(stub.creates[0]?.sessionId).toBe("sess-1");
		expect(stub.creates[0]?.cwd).toBe("/tmp");
	});

	test("throws when sessionId unbound", async () => {
		const stub = makeStubConn({ outputs: [""], exitCode: 0 });
		const ops = createAcpBashOperations({ conn: stub.conn, getSessionId: () => "" });
		await expect(ops.exec("echo x", "/tmp", { onData: () => {} })).rejects.toThrow(
			/sessionId not yet bound/,
		);
	});

	test("streams output deltas via onData and drains final snapshot", async () => {
		const stub = makeStubConn({
			outputs: ["foo\n", "foo\nbar\n", "foo\nbar\nbaz\n"],
			exitCode: 0,
			exitDelayMs: 250,
		});
		const ops = createAcpBashOperations({ conn: stub.conn, getSessionId: () => "s" });
		const chunks: string[] = [];
		const result = await ops.exec("seq 3", "/tmp", {
			onData: (b) => {
				chunks.push(b.toString("utf8"));
			},
		});
		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toContain("foo");
		expect(chunks.join("")).toContain("bar");
	});

	test("propagates env as ACP EnvVariable[]", async () => {
		const stub = makeStubConn({ outputs: [""], exitCode: 0 });
		const ops = createAcpBashOperations({ conn: stub.conn, getSessionId: () => "s" });
		await ops.exec("echo $X", "/tmp", {
			onData: () => {},
			env: { X: "1", Y: "two" },
		});
		const env = stub.creates[0]?.env ?? [];
		expect(env).toEqual(
			expect.arrayContaining([
				{ name: "X", value: "1" },
				{ name: "Y", value: "two" },
			]),
		);
	});

	test("kills terminal on AbortSignal", async () => {
		const stub = makeStubConn({ outputs: [""], exitCode: null, exitDelayMs: 5000 });
		const ops = createAcpBashOperations({ conn: stub.conn, getSessionId: () => "s" });
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 30);
		const result = await ops.exec("sleep 5", "/tmp", {
			onData: () => {},
			signal: ctrl.signal,
		});
		expect(stub.killed).toBe(true);
		expect(stub.released).toBe(true);
		expect(result.exitCode).toBeNull();
	});

	test("times out and kills terminal when options.timeout exceeded", async () => {
		const stub = makeStubConn({ outputs: [""], exitCode: null, exitDelayMs: 5000 });
		const ops = createAcpBashOperations({ conn: stub.conn, getSessionId: () => "s" });
		await ops.exec("sleep 5", "/tmp", {
			onData: () => {},
			timeout: 50,
		});
		expect(stub.killed).toBe(true);
		expect(stub.released).toBe(true);
	});

	test("always releases terminal in finally branch (even on early exit)", async () => {
		const stub = makeStubConn({ outputs: [""], exitCode: 0 });
		const ops = createAcpBashOperations({ conn: stub.conn, getSessionId: () => "s" });
		await ops.exec("true", "/tmp", { onData: () => {} });
		expect(stub.released).toBe(true);
	});
});
