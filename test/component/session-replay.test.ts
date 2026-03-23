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
		cwd: "/test/cwd",
		mcpServers: [],
		piSession: piSession as unknown as AgentSession,
		conn: asAgentConn(conn),
	});
	return { session, conn, piSession };
}

describe("session replay fidelity", () => {
	test("assistant text blocks emit agent_message_chunk", async () => {
		const { conn, piSession } = createSession();
		piSession.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Hello world" },
		} as never);
		await tick();

		expect(conn.updates[0]?.update).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Hello world" },
		});
	});

	test("thinking blocks emit agent_thought_chunk", async () => {
		const { conn, piSession } = createSession();
		piSession.emit({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "Let me think..." },
		} as never);
		await tick();

		expect(conn.updates[0]?.update).toEqual({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "Let me think..." },
		});
	});

	test("tool_execution_start emits tool_call with descriptive title", async () => {
		const { conn, piSession } = createSession();
		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "src/index.ts" },
		} as never);
		await tick();

		const update = conn.updates[0]?.update;
		expect(update).toBeDefined();
		expect(update?.sessionUpdate).toBe("tool_call");

		const tc = update as SessionUpdate & { title: string; kind: string };
		expect(tc.title).toBe("Read src/index.ts");
		expect(tc.kind).toBe("read");
	});

	test("bash tool gets descriptive Run title", async () => {
		const { conn, piSession } = createSession();
		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls -la" },
		} as never);
		await tick();

		const update = conn.updates[0]?.update;
		const tc = update as SessionUpdate & { title: string; kind: string };
		expect(tc.title).toBe("Run ls -la");
		expect(tc.kind).toBe("execute");
	});

	test("write tool gets descriptive Write title", async () => {
		const { conn, piSession } = createSession();
		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "write",
			args: { path: "output.txt" },
		} as never);
		await tick();

		const update = conn.updates[0]?.update;
		const tc = update as SessionUpdate & { title: string };
		expect(tc.title).toBe("Write output.txt");
	});

	test("edit tool gets descriptive Edit title", async () => {
		const { conn, piSession } = createSession();
		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "edit",
			args: { path: "src/main.ts" },
		} as never);
		await tick();

		const update = conn.updates[0]?.update;
		const tc = update as SessionUpdate & { title: string };
		expect(tc.title).toBe("Edit src/main.ts");
	});

	test("tool_call_update for in_progress gets updated title with path", async () => {
		const { conn, piSession } = createSession();

		// First, emit a toolcall_start from the message stream (no path yet)
		piSession.emit({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				partial: {
					content: [
						{
							type: "toolCall",
							id: "t1",
							name: "read",
							arguments: {},
						},
					],
				},
				contentIndex: 0,
			},
		} as never);
		await tick();

		// Then the tool actually starts with path args
		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "README.md" },
		} as never);
		await tick();

		// The second update should have the title from args
		const updates = conn.updates;
		expect(updates.length).toBeGreaterThanOrEqual(2);

		const secondUpdate = updates[1]?.update as SessionUpdate & { title: string };
		expect(secondUpdate.title).toBe("Read README.md");
	});
});
