import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { PiAcpSession } from "@pi-acp/acp/session";
import { asAgentConn, FakeAgentSession, FakeAgentSideConnection } from "../helpers/fakes";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PiAcpSession edit diff", () => {
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
});
