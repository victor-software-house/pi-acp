import { describe, expect, test } from "bun:test";
import { toolResultToText } from "@pi-acp/acp/translate/pi-tools";

describe("toolResultToText", () => {
	test("extracts text from content blocks", () => {
		expect(
			toolResultToText({
				content: [
					{ type: "text", text: "hello" },
					{ type: "text", text: " world" },
				],
			}),
		).toBe("hello world");
	});

	test("prefers details.diff when present", () => {
		expect(toolResultToText({ details: { diff: "--- a\n+++ b" } })).toBe("--- a\n+++ b");
	});

	test("falls back to JSON", () => {
		expect(toolResultToText({ a: 1 })).toMatch(/"a": 1/);
	});

	test("extracts bash stdout/stderr from details", () => {
		const text = toolResultToText({
			details: { stdout: "ok\n", stderr: "warn\n", exitCode: 0 },
		});
		expect(text).toMatch(/ok/);
		expect(text).toMatch(/stderr:/);
		expect(text).toMatch(/warn/);
		expect(text).toMatch(/exit code: 0/);
	});
});
