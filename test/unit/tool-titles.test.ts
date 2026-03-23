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

	test("unknown -> other", () => {
		expect(toToolKind("something_else")).toBe("other");
	});
});
