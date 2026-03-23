import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { PiAcpSession, SessionManager } from "@pi-acp/acp/session";
import { asAgentConn, FakeAgentSession, FakeAgentSideConnection } from "../helpers/fakes";

function createTestSession(id: string, cwd = process.cwd()) {
	const conn = new FakeAgentSideConnection();
	const piSession = new FakeAgentSession();
	const session = new PiAcpSession({
		sessionId: id,
		cwd,
		mcpServers: [],
		piSession: piSession as unknown as AgentSession,
		conn: asAgentConn(conn),
	});
	return { session, conn, piSession };
}

describe("SessionManager multi-session support", () => {
	test("register multiple sessions concurrently", () => {
		const mgr = new SessionManager();
		const { session: s1 } = createTestSession("s1");
		const { session: s2 } = createTestSession("s2");
		const { session: s3 } = createTestSession("s3");

		mgr.register(s1);
		mgr.register(s2);
		mgr.register(s3);

		expect(mgr.get("s1")).toBe(s1);
		expect(mgr.get("s2")).toBe(s2);
		expect(mgr.get("s3")).toBe(s3);
	});

	test("close disposes only targeted session", () => {
		const mgr = new SessionManager();
		const { session: s1 } = createTestSession("s1");
		const { session: s2 } = createTestSession("s2");

		mgr.register(s1);
		mgr.register(s2);

		mgr.close("s1");

		expect(mgr.maybeGet("s1")).toBeUndefined();
		expect(mgr.maybeGet("s2")).toBe(s2);
	});

	test("close unknown session is a no-op", () => {
		const mgr = new SessionManager();
		// Should not throw
		mgr.close("nonexistent");
	});

	test("get throws for unknown session", () => {
		const mgr = new SessionManager();
		expect(() => mgr.get("nonexistent")).toThrow();
	});

	test("maybeGet returns undefined for unknown session", () => {
		const mgr = new SessionManager();
		expect(mgr.maybeGet("nonexistent")).toBeUndefined();
	});

	test("disposeAll closes all sessions", () => {
		const mgr = new SessionManager();
		const { session: s1 } = createTestSession("s1");
		const { session: s2 } = createTestSession("s2");

		mgr.register(s1);
		mgr.register(s2);

		mgr.disposeAll();

		expect(mgr.maybeGet("s1")).toBeUndefined();
		expect(mgr.maybeGet("s2")).toBeUndefined();
	});

	test("registering same session ID replaces previous", () => {
		const mgr = new SessionManager();
		const { session: s1a } = createTestSession("s1");
		const { session: s1b } = createTestSession("s1");

		mgr.register(s1a);
		mgr.register(s1b);

		expect(mgr.get("s1")).toBe(s1b);
	});

	test("closeAllExcept keeps only the specified session", () => {
		const mgr = new SessionManager();
		const { session: s1 } = createTestSession("s1");
		const { session: s2 } = createTestSession("s2");
		const { session: s3 } = createTestSession("s3");

		mgr.register(s1);
		mgr.register(s2);
		mgr.register(s3);

		mgr.closeAllExcept("s2");

		expect(mgr.maybeGet("s1")).toBeUndefined();
		expect(mgr.maybeGet("s2")).toBe(s2);
		expect(mgr.maybeGet("s3")).toBeUndefined();
	});
});

describe("PiAcpSession concurrent events", () => {
	const tick = () => new Promise((r) => setTimeout(r, 0));

	test("events from one session do not leak to another", async () => {
		const conn1 = new FakeAgentSideConnection();
		const pi1 = new FakeAgentSession();
		new PiAcpSession({
			sessionId: "s1",
			cwd: process.cwd(),
			mcpServers: [],
			piSession: pi1 as unknown as AgentSession,
			conn: asAgentConn(conn1),
		});

		const conn2 = new FakeAgentSideConnection();
		const pi2 = new FakeAgentSession();
		new PiAcpSession({
			sessionId: "s2",
			cwd: process.cwd(),
			mcpServers: [],
			piSession: pi2 as unknown as AgentSession,
			conn: asAgentConn(conn2),
		});

		pi1.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "from-s1" },
		} as never);

		pi2.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "from-s2" },
		} as never);

		await tick();

		// s1 connection should only see s1 updates
		expect(conn1.updates).toHaveLength(1);
		expect(conn1.updates[0]?.sessionId).toBe("s1");

		// s2 connection should only see s2 updates
		expect(conn2.updates).toHaveLength(1);
		expect(conn2.updates[0]?.sessionId).toBe("s2");
	});
});
