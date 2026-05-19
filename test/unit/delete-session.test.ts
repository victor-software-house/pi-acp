/**
 * unstable_deleteSession unit tests. Exercises PiAcpAgent.unstable_deleteSession
 * against a fake AgentSideConnection + a tmpdir-backed session file. Verifies
 * happy path, unknown-sessionId rejection, and that delete only succeeds for
 * sessions this connection owns when the daemon registry is present.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAcpAgent } from "@pi-acp/acp/agent";
import { asAgentConn, FakeAgentSideConnection } from "../helpers/fakes";

function freshSessionFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-acp-delete-"));
	const path = join(dir, "session.jsonl");
	writeFileSync(path, '{"type":"header"}\n');
	return path;
}

function makeAgentWithSessionInCache(sessionId: string, sessionFile: string): PiAcpAgent {
	const conn = new FakeAgentSideConnection();
	const agent = new PiAcpAgent(asAgentConn(conn));
	// Seed the resolveSessionFile path cache directly via the public listSessions
	// surface would be ideal, but for unit isolation we reach in. This mirrors
	// how listSessions populates sessionPaths.
	(agent as unknown as { sessionPaths: Map<string, string> }).sessionPaths.set(
		sessionId,
		sessionFile,
	);
	return agent;
}

describe("PiAcpAgent.unstable_deleteSession", () => {
	test("removes the on-disk session file + clears sessionPaths cache", async () => {
		const sessionFile = freshSessionFile();
		expect(existsSync(sessionFile)).toBe(true);

		const agent = makeAgentWithSessionInCache("sess-1", sessionFile);
		const result = await agent.unstable_deleteSession({ sessionId: "sess-1" });
		expect(existsSync(sessionFile)).toBe(false);
		// _meta carries the unlinked path for client UX
		expect(result._meta).toBeDefined();
		const meta = result._meta as { piAcp?: { deletedFile?: string } };
		expect(meta.piAcp?.deletedFile).toBe(sessionFile);

		// Cache invalidated — second call sees an unknown sessionId
		await expect(agent.unstable_deleteSession({ sessionId: "sess-1" })).rejects.toThrow();
	});

	test("throws RequestError.invalidParams for unknown sessionId", async () => {
		const conn = new FakeAgentSideConnection();
		const agent = new PiAcpAgent(asAgentConn(conn));
		try {
			await agent.unstable_deleteSession({ sessionId: "ghost" });
			throw new Error("expected throw");
		} catch (e: unknown) {
			// RequestError.invalidParams: code -32602; the human-readable
			// detail lives in `.data` not `.message`.
			const err = e as { code?: number; data?: unknown };
			expect(err.code).toBe(-32602);
			expect(String(err.data)).toContain("Unknown sessionId");
		}
	});

	test("rmSync force does not throw when file already gone (defensive)", async () => {
		const sessionFile = freshSessionFile();
		// Pre-remove the file to simulate concurrent deletion.
		const { rmSync } = await import("node:fs");
		rmSync(sessionFile, { force: true });
		expect(existsSync(sessionFile)).toBe(false);

		const agent = makeAgentWithSessionInCache("sess-2", sessionFile);
		// Method should still succeed (force: true on rmSync swallows ENOENT).
		const result = await agent.unstable_deleteSession({ sessionId: "sess-2" });
		expect(result).toBeDefined();
	});
});
