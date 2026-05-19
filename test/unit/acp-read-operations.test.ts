/**
 * createAcpReadOperations: ACP-FS-backed ReadOperations for pi's `read` tool.
 * Tests stub AgentSideConnection.readTextFile and assert routing + sessionId
 * late-binding semantics.
 */

import { describe, expect, test } from "bun:test";

import { createAcpReadOperations } from "@pi-acp/acp/acp-read-operations";

interface RecordedCall {
	sessionId: string;
	path: string;
}

function makeStubConn(handler: (call: RecordedCall) => Promise<{ content: string }>): {
	conn: Parameters<typeof createAcpReadOperations>[0]["conn"];
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const conn = {
		async readTextFile(params: { sessionId: string; path: string }) {
			const call: RecordedCall = { sessionId: params.sessionId, path: params.path };
			calls.push(call);
			return handler(call);
		},
	} as unknown as Parameters<typeof createAcpReadOperations>[0]["conn"];
	return { conn, calls };
}

describe("createAcpReadOperations.readFile", () => {
	test("routes path through conn.readTextFile and returns Buffer with utf8 content", async () => {
		const { conn, calls } = makeStubConn(async (call) => ({
			content: `hello ${call.path}`,
		}));
		const ops = createAcpReadOperations({ conn, getSessionId: () => "sess-1" });
		const buf = await ops.readFile("/abs/path.ts");
		expect(buf).toBeInstanceOf(Buffer);
		expect(buf.toString("utf8")).toBe("hello /abs/path.ts");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ sessionId: "sess-1", path: "/abs/path.ts" });
	});

	test("throws when sessionId is empty (not yet bound)", async () => {
		const { conn, calls } = makeStubConn(async () => ({ content: "" }));
		const ops = createAcpReadOperations({ conn, getSessionId: () => "" });
		await expect(ops.readFile("/abs/path")).rejects.toThrow(/sessionId not yet bound/);
		expect(calls).toHaveLength(0);
	});

	test("honors late-bound sessionId via mutable ref", async () => {
		const ref = { current: "" };
		const { conn, calls } = makeStubConn(async () => ({ content: "ok" }));
		const ops = createAcpReadOperations({ conn, getSessionId: () => ref.current });

		// First attempt fails (ref empty)
		await expect(ops.readFile("/x")).rejects.toThrow(/sessionId not yet bound/);

		// Bind ref, second attempt succeeds with the bound id
		ref.current = "sess-late";
		await ops.readFile("/x");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.sessionId).toBe("sess-late");
	});

	test("propagates connection errors", async () => {
		const { conn } = makeStubConn(async () => {
			throw new Error("ACP transport closed");
		});
		const ops = createAcpReadOperations({ conn, getSessionId: () => "s" });
		await expect(ops.readFile("/x")).rejects.toThrow(/ACP transport closed/);
	});
});

describe("createAcpReadOperations.access", () => {
	test("issues a readTextFile probe and discards the body", async () => {
		const { conn, calls } = makeStubConn(async () => ({ content: "discarded" }));
		const ops = createAcpReadOperations({ conn, getSessionId: () => "s" });
		await ops.access("/probe");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/probe");
	});

	test("throws when sessionId is empty", async () => {
		const { conn } = makeStubConn(async () => ({ content: "" }));
		const ops = createAcpReadOperations({ conn, getSessionId: () => "" });
		await expect(ops.access("/x")).rejects.toThrow(/sessionId not yet bound/);
	});

	test("propagates connection errors as access denial", async () => {
		const { conn } = makeStubConn(async () => {
			throw new Error("ENOENT");
		});
		const ops = createAcpReadOperations({ conn, getSessionId: () => "s" });
		await expect(ops.access("/missing")).rejects.toThrow(/ENOENT/);
	});
});

describe("createAcpReadOperations shape", () => {
	test("does not advertise detectImageMimeType (ACP fs is text-only)", () => {
		const { conn } = makeStubConn(async () => ({ content: "" }));
		const ops = createAcpReadOperations({ conn, getSessionId: () => "s" });
		expect(ops.detectImageMimeType).toBeUndefined();
	});
});
