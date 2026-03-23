import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { PiAcpSession } from "@pi-acp/acp/session";
import { asAgentConn, FakeAgentSession, FakeAgentSideConnection } from "../helpers/fakes";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PiAcpSession diff content", () => {
	test("emits ACP diff content for edit tool when file changes", async () => {
		const conn = new FakeAgentSideConnection();
		const piSession = new FakeAgentSession();

		const dir = mkdtempSync(join(tmpdir(), "pi-acp-diff-"));
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "a.txt");
		writeFileSync(filePath, "before\n", "utf8");

		new PiAcpSession({
			sessionId: "s1",
			cwd: dir,
			mcpServers: [],
			piSession: piSession as unknown as AgentSession,
			conn: asAgentConn(conn),
		});

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "edit",
			args: { path: "a.txt" },
		} as never);

		writeFileSync(filePath, "after\n", "utf8");

		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "edit",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		} as never);
		await tick();

		const end = conn.updates.find(
			(u) =>
				(u.update as Record<string, unknown>)["toolCallId"] === "t1" &&
				u.update.sessionUpdate === "tool_call_update",
		);
		expect(end).toBeDefined();

		const content = (end?.update as Record<string, unknown>)["content"];
		expect(Array.isArray(content)).toBe(true);

		const diff = (content as Record<string, unknown>[]).find((c) => c["type"] === "diff");
		expect(diff).toBeDefined();
		expect(diff?.["path"]).toBe(filePath);
		expect(diff?.["oldText"]).toBe("before\n");
		expect(diff?.["newText"]).toBe("after\n");
	});

	test("emits ACP diff content for write tool on new file", async () => {
		const conn = new FakeAgentSideConnection();
		const piSession = new FakeAgentSession();

		const dir = mkdtempSync(join(tmpdir(), "pi-acp-write-diff-"));
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "new-file.txt");

		new PiAcpSession({
			sessionId: "s1",
			cwd: dir,
			mcpServers: [],
			piSession: piSession as unknown as AgentSession,
			conn: asAgentConn(conn),
		});

		// Start write tool -- file does not exist yet
		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "write",
			args: { path: "new-file.txt" },
		} as never);

		// Simulate write creating the file
		writeFileSync(filePath, "new content\n", "utf8");

		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "write",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		} as never);
		await tick();

		const end = conn.updates.find(
			(u) =>
				(u.update as Record<string, unknown>)["toolCallId"] === "t2" &&
				u.update.sessionUpdate === "tool_call_update" &&
				(u.update as Record<string, unknown>)["status"] === "completed",
		);
		expect(end).toBeDefined();

		const content = (end?.update as Record<string, unknown>)["content"];
		expect(Array.isArray(content)).toBe(true);

		const diff = (content as Record<string, unknown>[]).find((c) => c["type"] === "diff");
		expect(diff).toBeDefined();
		expect(diff?.["path"]).toBe(filePath);
		expect(diff?.["oldText"]).toBe("");
		expect(diff?.["newText"]).toBe("new content\n");
	});

	test("emits ACP diff content for write tool overwriting existing file", async () => {
		const conn = new FakeAgentSideConnection();
		const piSession = new FakeAgentSession();

		const dir = mkdtempSync(join(tmpdir(), "pi-acp-write-overwrite-"));
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "existing.txt");
		writeFileSync(filePath, "original\n", "utf8");

		new PiAcpSession({
			sessionId: "s1",
			cwd: dir,
			mcpServers: [],
			piSession: piSession as unknown as AgentSession,
			conn: asAgentConn(conn),
		});

		piSession.emit({
			type: "tool_execution_start",
			toolCallId: "t3",
			toolName: "write",
			args: { path: "existing.txt" },
		} as never);

		writeFileSync(filePath, "updated\n", "utf8");

		piSession.emit({
			type: "tool_execution_end",
			toolCallId: "t3",
			toolName: "write",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }] },
		} as never);
		await tick();

		const end = conn.updates.find(
			(u) =>
				(u.update as Record<string, unknown>)["toolCallId"] === "t3" &&
				u.update.sessionUpdate === "tool_call_update" &&
				(u.update as Record<string, unknown>)["status"] === "completed",
		);
		expect(end).toBeDefined();

		const content = (end?.update as Record<string, unknown>)["content"];
		expect(Array.isArray(content)).toBe(true);

		const diff = (content as Record<string, unknown>[]).find((c) => c["type"] === "diff");
		expect(diff).toBeDefined();
		expect(diff?.["path"]).toBe(filePath);
		expect(diff?.["oldText"]).toBe("original\n");
		expect(diff?.["newText"]).toBe("updated\n");
	});
});
