import { describe, expect, test } from "bun:test";

// Re-implement the truncateSessionTitle logic for unit testing since it's
// a module-private function. The real implementation is validated indirectly
// through integration tests; these tests validate the algorithm.

const SESSION_TITLE_MAX = 100;

function truncateSessionTitle(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	const oneLine = trimmed.replace(/\n/g, " ");
	if (oneLine.length <= SESSION_TITLE_MAX) return oneLine;
	return `${oneLine.slice(0, SESSION_TITLE_MAX - 1)}…`;
}

describe("truncateSessionTitle", () => {
	test("returns null for empty string", () => {
		expect(truncateSessionTitle("")).toBeNull();
	});

	test("returns null for whitespace-only string", () => {
		expect(truncateSessionTitle("   ")).toBeNull();
	});

	test("returns text as-is for short messages", () => {
		expect(truncateSessionTitle("Hello world")).toBe("Hello world");
	});

	test("collapses newlines to spaces", () => {
		expect(truncateSessionTitle("line1\nline2\nline3")).toBe("line1 line2 line3");
	});

	test("truncates long messages", () => {
		const long = "a".repeat(200);
		const result = truncateSessionTitle(long);
		expect(result).not.toBeNull();
		expect(result!.length).toBeLessThanOrEqual(SESSION_TITLE_MAX);
		expect(result!.endsWith("…")).toBe(true);
	});

	test("trims leading/trailing whitespace", () => {
		expect(truncateSessionTitle("  hello  ")).toBe("hello");
	});
});
