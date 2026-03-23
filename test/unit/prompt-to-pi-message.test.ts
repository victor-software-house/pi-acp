import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { acpPromptToPiMessage } from "@pi-acp/acp/translate/prompt";

describe("acpPromptToPiMessage", () => {
	test("concatenates text and resource links", () => {
		const { message, images } = acpPromptToPiMessage([
			{ type: "text", text: "Hello" },
			{ type: "resource_link", uri: "file:///tmp/foo.txt", name: "foo" },
			{ type: "text", text: " world" },
		]);
		expect(message).toBe("Hello\n[Context] file:///tmp/foo.txt world");
		expect(images).toEqual([]);
	});

	test("includes embedded resource text", () => {
		const blocks: ContentBlock[] = [
			{
				type: "resource",
				resource: { uri: "file:///tmp/a.txt", mimeType: "text/plain", text: "hi" },
			},
		];
		const { message, images } = acpPromptToPiMessage(blocks);
		expect(message).toBe("\n[Embedded Context] file:///tmp/a.txt (text/plain)\nhi");
		expect(images).toEqual([]);
	});

	test("includes embedded resource blob", () => {
		const blob = Buffer.from("xyz", "utf8").toString("base64");
		const blocks: ContentBlock[] = [
			{
				type: "resource",
				resource: { uri: "file:///tmp/a.bin", mimeType: "application/octet-stream", blob },
			},
		];
		const { message, images } = acpPromptToPiMessage(blocks);
		expect(message).toBe(
			"\n[Embedded Context] file:///tmp/a.bin (application/octet-stream, 3 bytes)",
		);
		expect(images).toEqual([]);
	});

	test("maps image to pi image content", () => {
		const data = Buffer.from("abc", "utf8").toString("base64");
		const { message, images } = acpPromptToPiMessage([
			{ type: "text", text: "see" },
			{ type: "image", mimeType: "image/png", data },
		]);
		expect(message).toBe("see");
		expect(images).toHaveLength(1);
		expect(images[0]).toEqual({ type: "image", mimeType: "image/png", data });
	});

	test("audio is noted as unsupported", () => {
		const data = Buffer.from("abc", "utf8").toString("base64");
		const blocks: ContentBlock[] = [{ type: "audio", mimeType: "audio/wav", data }];
		const { message } = acpPromptToPiMessage(blocks);
		expect(message).toContain("[Audio]");
		expect(message).toContain("not supported");
	});
});
