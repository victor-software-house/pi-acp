import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { PiAcpSession } from "../../src/acp/session.js";
import { asAgentConn, FakeAgentSession, FakeAgentSideConnection } from "../helpers/fakes.js";

function createSession(cwd = process.cwd()) {
	const conn = new FakeAgentSideConnection();
	const piSession = new FakeAgentSession();
	const session = new PiAcpSession({
		sessionId: "s1",
		cwd,
		mcpServers: [],
		piSession: piSession as unknown as AgentSession,
		conn: asAgentConn(conn),
	});
	return { session, conn, piSession };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PiAcpSession event translation", () => {
	test("emits agent_message_chunk for text_delta", async () => {
		const { conn, piSession } = createSession();
		piSession.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hi" },
		} as never);
		await tick();

		expect(conn.updates).toHaveLength(1);
		expect(conn.updates[0]?.sessionId).toBe("s1");
		expect(conn.updates[0]?.update).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hi" },
		});
	});

	test("emits agent_thought_chunk for thinking_delta", async () => {
		const { conn, piSession } = createSession();
		piSession.emit({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." },
		} as never);
		await tick();

		expect(conn.updates).toHaveLength(1);
		expect(conn.updates[0]?.update).toEqual({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "thinking..." },
		});
	});

	test("emits tool_call + tool_call_update + completes", async () => {
		const { conn, piSession } = createSession();

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { cmd: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "running" }] },
		} as never);
		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "done" }] },
		} as never);
		await tick();

		expect(conn.updates).toHaveLength(3);
		expect(conn.updates[0]?.update.sessionUpdate).toBe("tool_call");
		expect(conn.updates[1]?.update.sessionUpdate).toBe("tool_call_update");
		expect(conn.updates[2]?.update.sessionUpdate).toBe("tool_call_update");
	});

	test("emits tool locations from path args", async () => {
		const { conn, piSession } = createSession();
		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "src/acp/session.ts" },
		} as never);
		await tick();

		expect(conn.updates).toHaveLength(1);
		const update = conn.updates[0]?.update;
		expect(update?.sessionUpdate).toBe("tool_call");
		expect((update as Record<string, unknown>)["locations"]).toEqual([
			{ path: `${process.cwd()}/src/acp/session.ts` },
		]);
	});

	test("startup info emits on sendStartupInfoIfPending", async () => {
		const { session, conn } = createSession();
		session.setStartupInfo("Welcome!");
		session.sendStartupInfoIfPending();
		await tick();

		expect(conn.updates).toHaveLength(1);
		expect(conn.updates[0]?.update).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Welcome!" },
		});

		session.sendStartupInfoIfPending();
		await tick();
		expect(conn.updates).toHaveLength(1);
	});
});
