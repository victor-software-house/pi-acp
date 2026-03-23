import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { PiAcpSession } from "@pi-acp/acp/session";
import { asAgentConn, FakeAgentSession, FakeAgentSideConnection } from "../helpers/fakes";

function createSession(opts?: { cwd?: string; supportsTerminalOutput?: boolean }) {
	const conn = new FakeAgentSideConnection();
	const piSession = new FakeAgentSession();
	const session = new PiAcpSession({
		sessionId: "s1",
		cwd: opts?.cwd ?? process.cwd(),
		mcpServers: [],
		piSession: piSession as unknown as AgentSession,
		conn: asAgentConn(conn),
		supportsTerminalOutput: opts?.supportsTerminalOutput ?? false,
	});
	return { session, conn, piSession };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

type R = Record<string, unknown>;

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
		expect((update as R)["locations"]).toEqual([{ path: `${process.cwd()}/src/acp/session.ts` }]);
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

// ---------------------------------------------------------------------------
// Phase 1: Tool output formatting
// ---------------------------------------------------------------------------

describe("tool output formatting (Phase 1)", () => {
	test("bash tool_end wraps output in console code fence", async () => {
		const { conn, piSession } = createSession();

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "file1\nfile2" }] },
		} as never);
		await tick();

		const endUpdate = conn.updates.find(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" && (u.update as R)["status"] === "completed",
		);
		expect(endUpdate).toBeDefined();
		const content = (endUpdate?.update as R)["content"] as R[];
		expect(Array.isArray(content)).toBe(true);

		const textBlock = content.find((c) => c["type"] === "content");
		expect(textBlock).toBeDefined();
		const inner = textBlock?.["content"] as R;
		expect(inner["text"]).toBe("```console\nfile1\nfile2\n```");
	});

	test("bash error wraps in code fence", async () => {
		const { conn, piSession } = createSession();

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "bad" },
		} as never);
		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			isError: true,
			result: { content: [{ type: "text", text: "command not found" }] },
		} as never);
		await tick();

		const endUpdate = conn.updates.find(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" && (u.update as R)["status"] === "failed",
		);
		expect(endUpdate).toBeDefined();
		const content = (endUpdate?.update as R)["content"] as R[];
		expect(Array.isArray(content)).toBe(true);
		const textBlock = content.find((c) => c["type"] === "content");
		const inner = textBlock?.["content"] as R;
		expect(inner["text"]).toBe("```\ncommand not found\n```");
	});

	test("read tool markdown-escapes output", async () => {
		const { conn, piSession } = createSession();

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "README.md" },
		} as never);
		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			isError: false,
			result: { content: [{ type: "text", text: "# Title\n[link](url)" }] },
		} as never);
		await tick();

		const endUpdate = conn.updates.find(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" && (u.update as R)["status"] === "completed",
		);
		const content = (endUpdate?.update as R)["content"] as R[];
		expect(Array.isArray(content)).toBe(true);
		const textBlock = content.find((c) => c["type"] === "content");
		const inner = textBlock?.["content"] as R;
		expect(inner["text"]).toBe("\\# Title\n\\[link\\](url)");
	});
});

// ---------------------------------------------------------------------------
// Phase 2: Terminal content lifecycle
// ---------------------------------------------------------------------------

describe("terminal content lifecycle (Phase 2)", () => {
	test("emits terminal_info on tool_call when terminal supported", async () => {
		const { conn, piSession } = createSession({ supportsTerminalOutput: true });

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		await tick();

		const update = conn.updates[0]?.update as R;
		expect(update["sessionUpdate"]).toBe("tool_call");
		expect(update["_meta"]).toBeDefined();

		const meta = update["_meta"] as R;
		expect(meta["terminal_info"]).toEqual({
			terminal_id: "t1",
			cwd: process.cwd(),
		});

		// content should include terminal type
		const content = update["content"] as R[];
		expect(content).toBeDefined();
		expect(content[0]).toEqual({ type: "terminal", terminalId: "t1" });
	});

	test("emits terminal_output on tool_call_update when terminal supported", async () => {
		const { conn, piSession } = createSession({ supportsTerminalOutput: true });

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "streaming..." }] },
		} as never);
		await tick();

		const update = conn.updates[1]?.update as R;
		expect(update["sessionUpdate"]).toBe("tool_call_update");

		const meta = update["_meta"] as R;
		expect(meta["terminal_output"]).toEqual({
			terminal_id: "t1",
			data: "streaming...",
		});

		// No content field when terminal output is present
		expect(update["content"]).toBeUndefined();
	});

	test("emits terminal_exit on tool_call_update (end) when terminal supported", async () => {
		const { conn, piSession } = createSession({ supportsTerminalOutput: true });

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			result: { details: { stdout: "done", exitCode: 0 } },
		} as never);
		await tick();

		const endUpdate = conn.updates.find(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" && (u.update as R)["status"] === "completed",
		);
		expect(endUpdate).toBeDefined();

		const meta = (endUpdate?.update as R)["_meta"] as R;
		expect(meta["terminal_exit"]).toEqual({
			terminal_id: "t1",
			exit_code: 0,
			signal: null,
		});
	});

	test("falls back to code fences without terminal support", async () => {
		const { conn, piSession } = createSession({ supportsTerminalOutput: false });

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "output" }] },
		} as never);
		await tick();

		const update = conn.updates[1]?.update as R;
		const meta = update["_meta"] as R;
		// No terminal_output in meta
		expect(meta["terminal_output"]).toBeUndefined();

		// Content should have console code fence
		const content = update["content"] as R[] | null;
		expect(content).toBeDefined();
		expect(content).not.toBeNull();
		if (content !== null) {
			const inner = (content[0]?.["content"] as R)["text"];
			expect(inner).toBe("```console\noutput\n```");
		}
	});

	test("non-terminal tools do not get terminal metadata", async () => {
		const { conn, piSession } = createSession({ supportsTerminalOutput: true });

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "file.txt" },
		} as never);
		await tick();

		const update = conn.updates[0]?.update as R;
		const meta = update["_meta"] as R;
		expect(meta["terminal_info"]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Phase 3: _meta.piAcp.toolName on all emissions
// ---------------------------------------------------------------------------

describe("_meta.piAcp.toolName (Phase 3)", () => {
	test("present on tool_call from streaming", async () => {
		const { conn, piSession } = createSession();

		piSession.emit({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				partial: {
					content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
				},
				contentIndex: 0,
			},
		} as never);
		await tick();

		const update = conn.updates[0]?.update as R;
		const meta = update["_meta"] as R;
		expect(meta["piAcp"]).toEqual({ toolName: "bash" });
	});

	test("present on tool_call from tool_execution_start", async () => {
		const { conn, piSession } = createSession();

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "file.txt" },
		} as never);
		await tick();

		const update = conn.updates[0]?.update as R;
		const meta = update["_meta"] as R;
		expect(meta["piAcp"]).toEqual({ toolName: "read" });
	});

	test("present on tool_call_update from streaming", async () => {
		const { conn, piSession } = createSession();

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "out" }] },
		} as never);
		await tick();

		const update = conn.updates[1]?.update as R;
		const meta = update["_meta"] as R;
		expect(meta["piAcp"]).toEqual({ toolName: "bash" });
	});

	test("present on tool_call_update from tool_execution_end", async () => {
		const { conn, piSession } = createSession();

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "done" }] },
		} as never);
		await tick();

		const endUpdate = conn.updates.find(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" && (u.update as R)["status"] === "completed",
		);
		const meta = (endUpdate?.update as R)["_meta"] as R;
		expect(meta["piAcp"]).toEqual({ toolName: "bash" });
	});

	test("_meta merges correctly with terminal _meta", async () => {
		const { conn, piSession } = createSession({ supportsTerminalOutput: true });

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		await tick();

		const update = conn.updates[0]?.update as R;
		const meta = update["_meta"] as R;

		// Both piAcp and terminal_info should be present
		expect(meta["piAcp"]).toEqual({ toolName: "bash" });
		expect(meta["terminal_info"]).toEqual({
			terminal_id: "t1",
			cwd: process.cwd(),
		});
	});
});

// ---------------------------------------------------------------------------
// Phase 5: Streaming bash formatting
// ---------------------------------------------------------------------------

describe("streaming bash formatting (Phase 5)", () => {
	test("bash streaming wraps in console code fence without terminal support", async () => {
		const { conn, piSession } = createSession({ supportsTerminalOutput: false });

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "accumulated output" }] },
		} as never);
		await tick();

		const update = conn.updates[1]?.update as R;
		const content = update["content"] as R[];
		expect(content).toBeDefined();
		const inner = (content[0]?.["content"] as R)["text"];
		expect(inner).toBe("```console\naccumulated output\n```");
	});

	test("bash streaming emits terminal_output with terminal support", async () => {
		const { conn, piSession } = createSession({ supportsTerminalOutput: true });

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "streaming data" }] },
		} as never);
		await tick();

		const update = conn.updates[1]?.update as R;
		const meta = update["_meta"] as R;
		expect(meta["terminal_output"]).toEqual({
			terminal_id: "t1",
			data: "streaming data",
		});
		// No content in terminal mode
		expect(update["content"]).toBeUndefined();
	});

	test("non-bash streaming remains plain text", async () => {
		const { conn, piSession } = createSession({ supportsTerminalOutput: false });

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "file.txt" },
		} as never);
		piSession.emit({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "read",
			args: {},
			partialResult: { content: [{ type: "text", text: "file contents" }] },
		} as never);
		await tick();

		const update = conn.updates[1]?.update as R;
		const content = update["content"] as R[];
		expect(content).toBeDefined();
		const inner = (content[0]?.["content"] as R)["text"];
		// read streaming should be plain text, not wrapped in code fence
		expect(inner).toBe("file contents");
	});

	test("toolCallNames map is cleaned up after tool_execution_end", async () => {
		const { conn, piSession } = createSession();

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		} as never);
		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "done" }] },
		} as never);

		// Start a new tool with the same ID (synthetic scenario)
		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "file.txt" },
		} as never);
		piSession.emit({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "read",
			args: {},
			partialResult: { content: [{ type: "text", text: "reading" }] },
		} as never);
		await tick();

		// The streaming update for the second tool should use "read" formatting (plain text)
		const updates = conn.updates.filter(
			(u) =>
				u.update.sessionUpdate === "tool_call_update" &&
				(u.update as R)["status"] === "in_progress",
		);
		// Last in_progress update should be from the read tool
		const lastInProgress = updates[updates.length - 1];
		expect(lastInProgress).toBeDefined();
		const meta = (lastInProgress?.update as R)["_meta"] as R;
		expect(meta["piAcp"]).toEqual({ toolName: "read" });
	});
});
