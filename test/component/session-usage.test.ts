import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { PiAcpSession } from "@pi-acp/acp/session";
import { asAgentConn, FakeAgentSession, FakeAgentSideConnection } from "../helpers/fakes";

const tick = () => new Promise((r) => setTimeout(r, 0));

function createSession() {
	const conn = new FakeAgentSideConnection();
	const piSession = new FakeAgentSession();
	const session = new PiAcpSession({
		sessionId: "s1",
		cwd: process.cwd(),
		mcpServers: [],
		piSession: piSession as unknown as AgentSession,
		conn: asAgentConn(conn),
	});
	return { session, conn, piSession };
}

describe("usage updates", () => {
	test("emits usage_update on agent_end", async () => {
		const { conn, piSession } = createSession();

		// Simulate a complete turn: message_update -> agent_end
		piSession.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		} as never);

		piSession.emit({ type: "agent_end" } as never);
		await tick();

		const usageUpdate = conn.updates.find((u) => u.update.sessionUpdate === "usage_update");
		expect(usageUpdate).toBeDefined();

		const update = usageUpdate?.update as SessionUpdate & {
			used: number;
			size: number;
			cost: { amount: number; currency: string } | null;
		};
		expect(update.used).toBe(1000);
		expect(update.size).toBe(200000);
	});

	test("getUsage returns token counts from session stats", () => {
		const { session } = createSession();

		const usage = session.getUsage();
		expect(usage.inputTokens).toBe(0);
		expect(usage.outputTokens).toBe(0);
		expect(usage.cachedReadTokens).toBe(0);
		expect(usage.cachedWriteTokens).toBe(0);
	});

	test("getCost returns cumulative cost", () => {
		const { session } = createSession();
		expect(session.getCost()).toBe(0);
	});
});
