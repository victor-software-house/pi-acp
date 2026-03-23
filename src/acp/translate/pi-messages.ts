/**
 * Extract plain text from pi message content.
 *
 * Pi messages store content as either a string or an array of typed blocks.
 * These helpers extract the text portions for ACP session replay.
 */

interface TextBlock {
	type: "text";
	text: string;
}

function isTextBlock(block: unknown): block is TextBlock {
	if (typeof block !== "object" || block === null) return false;
	return (
		"type" in block && block.type === "text" && "text" in block && typeof block.text === "string"
	);
}

export function extractUserMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((b) => b.text)
		.join("");
}

export function extractAssistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextBlock)
		.map((b) => b.text)
		.join("");
}
