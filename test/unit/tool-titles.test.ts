import { describe, expect, test } from "bun:test";
import { buildToolTitle, toToolKind } from "@pi-acp/acp/session";

describe("buildToolTitle", () => {
	test("read with path", () => {
		expect(buildToolTitle("read", { path: "src/index.ts" })).toBe("Read src/index.ts");
	});

	test("read without path", () => {
		expect(buildToolTitle("read", {})).toBe("Read");
	});

	test("write with path", () => {
		expect(buildToolTitle("write", { path: "out/file.txt" })).toBe("Write out/file.txt");
	});

	test("edit with path", () => {
		expect(buildToolTitle("edit", { path: "src/main.rs" })).toBe("Edit src/main.rs");
	});

	test("bash with command arg", () => {
		expect(buildToolTitle("bash", { command: "ls -la" })).toBe("Run ls -la");
	});

	test("bash with cmd arg", () => {
		expect(buildToolTitle("bash", { cmd: "echo hi" })).toBe("Run echo hi");
	});

	test("bash without command", () => {
		expect(buildToolTitle("bash", {})).toBe("bash");
	});

	test("bash with long command is truncated", () => {
		const longCmd = "a".repeat(200);
		const title = buildToolTitle("bash", { command: longCmd });
		expect(title.length).toBeLessThanOrEqual(80);
		expect(title.endsWith("…")).toBe(true);
	});

	test("bash with multiline command collapses to one line", () => {
		const title = buildToolTitle("bash", { command: "echo\nfoo\nbar" });
		expect(title).toBe("Run echo foo bar");
	});

	test("unknown tool returns name as-is", () => {
		expect(buildToolTitle("custom_tool", {})).toBe("custom_tool");
	});

	// Phase 3: lsp titles
	test("lsp with action and file", () => {
		expect(buildToolTitle("lsp", { action: "definition", file: "src/index.ts", line: 42 })).toBe(
			"Definition src/index.ts:42",
		);
	});

	test("lsp with action and file without line", () => {
		expect(buildToolTitle("lsp", { action: "references", file: "src/main.ts" })).toBe(
			"References src/main.ts",
		);
	});

	test("lsp with action and query", () => {
		expect(buildToolTitle("lsp", { action: "hover", query: "MyClass" })).toBe("Hover MyClass");
	});

	test("lsp with action only", () => {
		expect(buildToolTitle("lsp", { action: "diagnostics" })).toBe("Diagnostics");
	});

	test("lsp without action", () => {
		expect(buildToolTitle("lsp", {})).toBe("LSP");
	});

	// Phase 3: tmux titles
	test("tmux run with command", () => {
		expect(buildToolTitle("tmux", { action: "run", command: "npm test" })).toBe("Tmux: npm test");
	});

	test("tmux action with name", () => {
		expect(buildToolTitle("tmux", { action: "peek", name: "dev-server" })).toBe(
			"Tmux peek dev-server",
		);
	});

	test("tmux action only", () => {
		expect(buildToolTitle("tmux", { action: "list" })).toBe("Tmux list");
	});

	test("tmux without action", () => {
		expect(buildToolTitle("tmux", {})).toBe("Tmux");
	});

	// Phase 3: context tool titles
	test("context_tag with name", () => {
		expect(buildToolTitle("context_tag", { name: "milestone-1" })).toBe("Tag milestone-1");
	});

	test("context_tag without name", () => {
		expect(buildToolTitle("context_tag", {})).toBe("Tag");
	});

	test("context_log", () => {
		expect(buildToolTitle("context_log", {})).toBe("Context log");
	});

	test("context_checkout with target", () => {
		expect(buildToolTitle("context_checkout", { target: "task-start" })).toBe(
			"Checkout task-start",
		);
	});

	test("context_checkout without target", () => {
		expect(buildToolTitle("context_checkout", {})).toBe("Checkout");
	});

	test("claudemon", () => {
		expect(buildToolTitle("claudemon", {})).toBe("Check quota");
	});
});

describe("toToolKind", () => {
	test("read -> read", () => {
		expect(toToolKind("read")).toBe("read");
	});

	test("write -> edit", () => {
		expect(toToolKind("write")).toBe("edit");
	});

	test("edit -> edit", () => {
		expect(toToolKind("edit")).toBe("edit");
	});

	test("bash -> execute", () => {
		expect(toToolKind("bash")).toBe("execute");
	});

	// Phase 3: new kind mappings
	test("tmux -> execute", () => {
		expect(toToolKind("tmux")).toBe("execute");
	});

	test("lsp -> search", () => {
		expect(toToolKind("lsp")).toBe("search");
	});

	test("unknown -> other", () => {
		expect(toToolKind("something_else")).toBe("other");
	});
});
