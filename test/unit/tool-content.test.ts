import { describe, expect, test } from "bun:test";
import {
	extractBashOutput,
	extractContentBlocks,
	extractTextContent,
	formatToolContent,
	markdownEscape,
	wrapStreamingBashOutput,
} from "@pi-acp/acp/translate/tool-content";

type R = Record<string, unknown>;

// ---------------------------------------------------------------------------
// markdownEscape
// ---------------------------------------------------------------------------

describe("markdownEscape", () => {
	test("escapes headings at line start", () => {
		expect(markdownEscape("# Heading")).toBe("\\# Heading");
		expect(markdownEscape("## Sub")).toBe("\\## Sub");
	});

	test("does not escape # in the middle of text", () => {
		expect(markdownEscape("a # b")).toBe("a # b");
	});

	test("escapes square brackets", () => {
		expect(markdownEscape("[link](url)")).toBe("\\[link\\](url)");
	});

	test("escapes angle brackets", () => {
		expect(markdownEscape("<div>")).toBe("\\<div>");
	});

	test("escapes horizontal rules", () => {
		expect(markdownEscape("---")).toBe("\\---");
		expect(markdownEscape("***")).toBe("\\***");
		expect(markdownEscape("___")).toBe("\\___");
	});

	test("preserves normal text", () => {
		expect(markdownEscape("hello world")).toBe("hello world");
	});
});

// ---------------------------------------------------------------------------
// extractBashOutput
// ---------------------------------------------------------------------------

describe("extractBashOutput", () => {
	test("extracts from content blocks", () => {
		const result = extractBashOutput({
			content: [{ type: "text", text: "hello" }],
		});
		expect(result.output).toBe("hello");
		expect(result.exitCode).toBeUndefined();
	});

	test("extracts from details.stdout", () => {
		const result = extractBashOutput({
			details: { stdout: "ok\n", exitCode: 0 },
		});
		expect(result.output).toBe("ok\n");
		expect(result.exitCode).toBe(0);
	});

	test("combines stdout and stderr", () => {
		const result = extractBashOutput({
			details: { stdout: "out", stderr: "err", exitCode: 1 },
		});
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
		expect(result.exitCode).toBe(1);
	});

	test("returns empty for null/undefined", () => {
		expect(extractBashOutput(null).output).toBe("");
		expect(extractBashOutput(undefined).output).toBe("");
	});

	test("returns empty for non-object", () => {
		expect(extractBashOutput("string").output).toBe("");
	});

	test("extracts from top-level stdout/exitCode", () => {
		const result = extractBashOutput({ stdout: "top-level", exitCode: 42 });
		expect(result.output).toBe("top-level");
		expect(result.exitCode).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// extractTextContent
// ---------------------------------------------------------------------------

describe("extractTextContent", () => {
	test("joins text blocks", () => {
		expect(
			extractTextContent({
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			}),
		).toBe("ab");
	});

	test("falls back to JSON for unknown shapes", () => {
		const result = extractTextContent({ custom: "data" });
		expect(result).toContain("custom");
	});

	test("returns empty for null", () => {
		expect(extractTextContent(null)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// extractContentBlocks
// ---------------------------------------------------------------------------

describe("extractContentBlocks", () => {
	test("extracts text and image blocks", () => {
		const blocks = extractContentBlocks({
			content: [{ type: "text", text: "hello" }, { type: "image" }, { type: "unknown" }],
		});
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toEqual({ type: "text", text: "hello" });
		expect(blocks[1]).toEqual({ type: "image" });
	});

	test("returns empty for missing content", () => {
		expect(extractContentBlocks({})).toEqual([]);
		expect(extractContentBlocks(null)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// formatToolContent - bash
// ---------------------------------------------------------------------------

describe("formatToolContent - bash", () => {
	test("wraps stdout in console code fence", () => {
		const content = formatToolContent(
			"bash",
			{ content: [{ type: "text", text: "file1\nfile2" }] },
			false,
		);
		expect(content).toHaveLength(1);
		const block = content[0] as R;
		const inner = block["content"] as R;
		expect(inner["text"]).toBe("```console\nfile1\nfile2\n```");
	});

	test("appends exit code on non-zero", () => {
		const content = formatToolContent(
			"bash",
			{ details: { stdout: "error output", exitCode: 1 } },
			false,
		);
		expect(content).toHaveLength(1);
		const inner = (content[0] as R)["content"] as R;
		const text = inner["text"] as string;
		expect(text).toContain("```console");
		expect(text).toContain("exit code: 1");
	});

	test("does not append exit code on zero", () => {
		const content = formatToolContent("bash", { details: { stdout: "ok", exitCode: 0 } }, false);
		expect(content).toHaveLength(1);
		const inner = (content[0] as R)["content"] as R;
		const text = inner["text"] as string;
		expect(text).not.toContain("exit code");
	});

	test("returns empty for empty output", () => {
		const content = formatToolContent("bash", { content: [{ type: "text", text: "" }] }, false);
		expect(content).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// formatToolContent - tmux
// ---------------------------------------------------------------------------

describe("formatToolContent - tmux", () => {
	test("wraps output in console code fence (same as bash)", () => {
		const content = formatToolContent(
			"tmux",
			{ content: [{ type: "text", text: "tmux output" }] },
			false,
		);
		expect(content).toHaveLength(1);
		const inner = (content[0] as R)["content"] as R;
		expect(inner["text"]).toBe("```console\ntmux output\n```");
	});
});

// ---------------------------------------------------------------------------
// formatToolContent - read
// ---------------------------------------------------------------------------

describe("formatToolContent - read", () => {
	test("markdown-escapes text content", () => {
		const content = formatToolContent(
			"read",
			{ content: [{ type: "text", text: "# Heading\n[link](url)" }] },
			false,
		);
		expect(content).toHaveLength(1);
		const inner = (content[0] as R)["content"] as R;
		expect(inner["text"]).toBe("\\# Heading\n\\[link\\](url)");
	});

	test("returns empty for empty content", () => {
		const content = formatToolContent("read", { content: [] }, false);
		expect(content).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// formatToolContent - edit/write
// ---------------------------------------------------------------------------

describe("formatToolContent - edit/write", () => {
	test("edit returns empty (diff handled separately)", () => {
		const content = formatToolContent("edit", { content: [{ type: "text", text: "ok" }] }, false);
		expect(content).toHaveLength(0);
	});

	test("write returns empty (diff handled separately)", () => {
		const content = formatToolContent("write", { content: [{ type: "text", text: "ok" }] }, false);
		expect(content).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// formatToolContent - lsp
// ---------------------------------------------------------------------------

describe("formatToolContent - lsp", () => {
	test("wraps output in code fence", () => {
		const content = formatToolContent(
			"lsp",
			{ content: [{ type: "text", text: "definition result" }] },
			false,
		);
		expect(content).toHaveLength(1);
		const inner = (content[0] as R)["content"] as R;
		expect(inner["text"]).toBe("```\ndefinition result\n```");
	});
});

// ---------------------------------------------------------------------------
// formatToolContent - errors
// ---------------------------------------------------------------------------

describe("formatToolContent - errors", () => {
	test("wraps error text in code fence for bash", () => {
		const content = formatToolContent(
			"bash",
			{ content: [{ type: "text", text: "command not found" }] },
			true,
		);
		expect(content).toHaveLength(1);
		const inner = (content[0] as R)["content"] as R;
		expect(inner["text"]).toBe("```\ncommand not found\n```");
	});

	test("wraps error text in code fence for read", () => {
		const content = formatToolContent(
			"read",
			{ content: [{ type: "text", text: "file not found" }] },
			true,
		);
		expect(content).toHaveLength(1);
		const inner = (content[0] as R)["content"] as R;
		expect(inner["text"]).toBe("```\nfile not found\n```");
	});

	test("returns empty for error with no text", () => {
		const content = formatToolContent("bash", null, true);
		expect(content).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// formatToolContent - fallback
// ---------------------------------------------------------------------------

describe("formatToolContent - fallback (unknown tools)", () => {
	test("returns plain text for unknown tools", () => {
		const content = formatToolContent(
			"custom_tool",
			{ content: [{ type: "text", text: "result" }] },
			false,
		);
		expect(content).toHaveLength(1);
		const inner = (content[0] as R)["content"] as R;
		expect(inner["text"]).toBe("result");
	});
});

// ---------------------------------------------------------------------------
// wrapStreamingBashOutput
// ---------------------------------------------------------------------------

describe("wrapStreamingBashOutput", () => {
	test("wraps non-empty text in console code fence", () => {
		expect(wrapStreamingBashOutput("running...")).toBe("```console\nrunning...\n```");
	});

	test("returns empty string for empty input", () => {
		expect(wrapStreamingBashOutput("")).toBe("");
	});
});
