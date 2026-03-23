import { describe, expect, test } from "bun:test";
import { extractAssistantText, extractUserMessageText } from "@pi-acp/acp/translate/pi-messages.js";

describe("extractUserMessageText", () => {
	test("supports string content", () => {
		expect(extractUserMessageText("hello")).toBe("hello");
	});

	test("joins text blocks and ignores non-text", () => {
		expect(
			extractUserMessageText([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
				{ type: "not_text", x: 1 },
			]),
		).toBe("ab");
	});
});

describe("extractAssistantText", () => {
	test("joins only text blocks", () => {
		expect(
			extractAssistantText([
				{ type: "text", text: "hi" },
				{ type: "thinking", text: "..." },
				{ type: "text", text: "!" },
			]),
		).toBe("hi!");
	});
});
