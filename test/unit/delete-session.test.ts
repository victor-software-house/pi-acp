/**
 * unstable_deleteSession is DISABLED by default via
 * PiAcpAgent.SESSION_DELETE_ENABLED. These tests assert the disabled
 * surface contract: any direct invocation throws methodNotFound and the
 * on-disk session file is left untouched. The capability is also NOT
 * advertised in initialize() — covered separately in protocol-surface.test.ts.
 *
 * When the flag is flipped to true, the (kept) implementation does:
 *  - release-from-daemon → sessions.close → fs.rmSync(sessionFile) → cache purge
 *
 * Don't re-enable without adding a confirmation flow at the client layer.
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
	(agent as unknown as { sessionPaths: Map<string, string> }).sessionPaths.set(
		sessionId,
		sessionFile,
	);
	return agent;
}

describe("PiAcpAgent.unstable_deleteSession (DISABLED by default)", () => {
	test("any call throws methodNotFound (code -32601) regardless of sessionId", async () => {
		const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
		try {
			await agent.unstable_deleteSession({ sessionId: "anything" });
			throw new Error("expected throw");
		} catch (e: unknown) {
			const err = e as { code?: number };
			expect(err.code).toBe(-32601);
		}
	});

	test("does NOT touch the on-disk session file even when sessionId resolves", async () => {
		const sessionFile = freshSessionFile();
		expect(existsSync(sessionFile)).toBe(true);

		const agent = makeAgentWithSessionInCache("sess-1", sessionFile);
		try {
			await agent.unstable_deleteSession({ sessionId: "sess-1" });
		} catch {
			/* expected — disabled */
		}
		// File still present — refusal happens before any fs work.
		expect(existsSync(sessionFile)).toBe(true);
	});
});
