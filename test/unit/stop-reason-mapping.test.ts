import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { PiAcpSession } from "../../src/acp/session.js";
import { asAgentConn, FakeAgentSession, FakeAgentSideConnection } from "../helpers/fakes.js";

function createSession() {
	const conn = new FakeAgentSideConnection();
	const fake = new FakeAgentSession();
	const session = new PiAcpSession({
		sessionId: "test-session",
		cwd: "/tmp/test",
		mcpServers: [],
		piSession: fake as unknown as AgentSession,
		conn: asAgentConn(conn),
	});
	return { session, conn, fake };
}

describe("stop reason mapping", () => {
	test("stopReason 'stop' resolves as end_turn", async () => {
		const { session, fake } = createSession();
		const p = session.prompt("hello");
		fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } } as never);
		fake.emit({ type: "agent_end", messages: [] } as never);
		expect(await p).toBe("end_turn");
	});

	test("stopReason 'length' resolves as max_tokens", async () => {
		const { session, fake } = createSession();
		const p = session.prompt("hello");
		fake.emit({
			type: "message_end",
			message: { role: "assistant", stopReason: "length" },
		} as never);
		fake.emit({ type: "agent_end", messages: [] } as never);
		expect(await p).toBe("max_tokens");
	});

	test("stopReason 'aborted' resolves as cancelled", async () => {
		const { session, fake } = createSession();
		const p = session.prompt("hello");
		fake.emit({
			type: "message_end",
			message: { role: "assistant", stopReason: "aborted" },
		} as never);
		fake.emit({ type: "agent_end", messages: [] } as never);
		expect(await p).toBe("cancelled");
	});

	test("stopReason 'error' resolves as error", async () => {
		const { session, fake } = createSession();
		const p = session.prompt("hello");
		fake.emit({
			type: "message_end",
			message: { role: "assistant", stopReason: "error" },
		} as never);
		fake.emit({ type: "agent_end", messages: [] } as never);
		expect(await p).toBe("error");
	});

	test("no message_end defaults to end_turn", async () => {
		const { session, fake } = createSession();
		const p = session.prompt("hello");
		fake.emit({ type: "agent_end", messages: [] } as never);
		expect(await p).toBe("end_turn");
	});

	test("cancel overrides stopReason to cancelled", async () => {
		const { session, fake } = createSession();
		const p = session.prompt("hello");
		await session.cancel();
		fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } } as never);
		fake.emit({ type: "agent_end", messages: [] } as never);
		expect(await p).toBe("cancelled");
	});
});
