/**
 * Per-tool content formatting for ACP tool results.
 *
 * Dispatches formatting by tool name following the reference implementation
 * pattern (claude-agent-acp / codex-acp). Each tool type produces
 * `ToolCallContent[]` appropriate for its output shape.
 */

import type { ToolCallContent } from "@agentclientprotocol/sdk";
import * as z from "zod";

// ---------------------------------------------------------------------------
// Zod schemas for pi tool result shapes
// ---------------------------------------------------------------------------

const textBlockSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

const imageBlockSchema = z.object({
	type: z.literal("image"),
});

const contentBlockSchema = z.union([textBlockSchema, imageBlockSchema]);

const bashDetailsSchema = z.object({
	stdout: z.string().optional(),
	stderr: z.string().optional(),
	output: z.string().optional(),
	exitCode: z.number().optional(),
	code: z.number().optional(),
});

const bashResultSchema = z.object({
	content: z.array(z.unknown()).optional(),
	details: bashDetailsSchema.optional(),
	stdout: z.string().optional(),
	stderr: z.string().optional(),
	output: z.string().optional(),
	exitCode: z.number().optional(),
	code: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

export interface BashOutput {
	output: string;
	exitCode: number | undefined;
}

/**
 * Extract stdout/stderr and exit code from a pi bash/tmux result.
 */
export function extractBashOutput(result: unknown): BashOutput {
	if (result === null || result === undefined || typeof result !== "object") {
		return { output: "", exitCode: undefined };
	}

	const parsed = bashResultSchema.safeParse(result);
	if (!parsed.success) {
		return { output: "", exitCode: undefined };
	}

	const r = parsed.data;
	const d = r.details;

	// Try content blocks first
	if (r.content !== undefined) {
		const texts = r.content
			.map((block) => textBlockSchema.safeParse(block))
			.filter((res) => res.success)
			.map((res) => res.data.text);
		if (texts.length > 0) {
			const exitCode = d?.exitCode ?? r.exitCode ?? d?.code ?? r.code;
			return { output: texts.join(""), exitCode };
		}
	}

	const stdout = d?.stdout ?? r.stdout ?? d?.output ?? r.output;
	const stderr = d?.stderr ?? r.stderr;
	const exitCode = d?.exitCode ?? r.exitCode ?? d?.code ?? r.code;

	const parts: string[] = [];
	if (stdout !== undefined && stdout.trim() !== "") parts.push(stdout);
	if (stderr !== undefined && stderr.trim() !== "") parts.push(stderr);

	return { output: parts.join("\n"), exitCode };
}

/**
 * Extract text content from a pi tool result (generic).
 */
export function extractTextContent(result: unknown): string {
	if (result === null || result === undefined || typeof result !== "object") return "";

	if ("content" in result && Array.isArray(result.content)) {
		const texts: string[] = [];
		for (const block of result.content) {
			const parsed = textBlockSchema.safeParse(block);
			if (parsed.success) texts.push(parsed.data.text);
		}
		if (texts.length > 0) return texts.join("");
	}

	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

/**
 * Extract content blocks from a pi result, preserving type information.
 * Used for read results where images need to be preserved.
 */
export function extractContentBlocks(
	result: unknown,
): Array<{ type: "text"; text: string } | { type: "image" }> {
	if (result === null || result === undefined || typeof result !== "object") return [];
	if (!("content" in result) || !Array.isArray(result.content)) return [];

	const blocks: Array<{ type: "text"; text: string } | { type: "image" }> = [];
	for (const raw of result.content) {
		const parsed = contentBlockSchema.safeParse(raw);
		if (parsed.success) {
			blocks.push(parsed.data);
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Markdown escaping via dynamic backtick fence wrapping
// ---------------------------------------------------------------------------

/**
 * Find the longest consecutive backtick sequence in a string.
 */
function longestBacktickRun(text: string): number {
	let max = 0;
	let current = 0;
	for (const ch of text) {
		if (ch === "`") {
			current++;
			if (current > max) max = current;
		} else {
			current = 0;
		}
	}
	return max;
}

/**
 * Wrap text in a dynamically-sized backtick fence to prevent markdown rendering.
 *
 * Instead of character-level escaping (which fails on files containing backtick
 * sequences, indented code blocks, blockquotes, and list markers), this wraps
 * the entire text in a backtick fence whose length exceeds any backtick sequence
 * in the content. This approach is simpler and strictly more correct (following
 * the claude-agent-acp pattern).
 */
export function markdownEscape(text: string): string {
	if (text === "") return "";

	const fenceLen = Math.max(3, longestBacktickRun(text) + 1);
	const fence = "`".repeat(fenceLen);

	// Avoid a trailing double newline before the closing fence
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return `${fence}\n${body}\n${fence}`;
}

// ---------------------------------------------------------------------------
// Per-tool content formatting
// ---------------------------------------------------------------------------

/**
 * Format tool output into `ToolCallContent[]` by tool name.
 *
 * Returns the appropriate content shape for each tool type:
 * - bash/tmux: console code fences
 * - read: markdown-escaped text (images preserved)
 * - edit/write: empty (diff handled separately)
 * - lsp: code fences
 * - errors: code fences with failed status
 * - everything else: plain text
 */
export function formatToolContent(
	toolName: string,
	result: unknown,
	isError: boolean,
): ToolCallContent[] {
	// Error path: wrap any error text in a code fence
	if (isError) {
		const text = extractTextContent(result);
		if (text === "") return [];
		return [{ type: "content", content: { type: "text", text: `\`\`\`\n${text}\n\`\`\`` } }];
	}

	switch (toolName) {
		case "bash":
		case "tmux":
			return formatBashContent(result);

		case "read":
			return formatReadContent(result);

		case "edit":
		case "write":
			// Diff content is handled separately in handleToolEnd.
			// Return empty so the diff path takes precedence.
			return [];

		case "lsp":
			return formatLspContent(result);

		default:
			return formatFallbackContent(result);
	}
}

function formatBashContent(result: unknown): ToolCallContent[] {
	const { output, exitCode } = extractBashOutput(result);
	if (output === "" && exitCode === undefined) return [];

	const parts: string[] = [];
	if (output !== "") {
		parts.push(`\`\`\`console\n${output}\n\`\`\``);
	}
	if (exitCode !== undefined && exitCode !== 0) {
		parts.push(`exit code: ${exitCode}`);
	}

	const text = parts.join("\n\n");
	if (text === "") return [];
	return [{ type: "content", content: { type: "text", text } }];
}

function formatReadContent(result: unknown): ToolCallContent[] {
	const blocks = extractContentBlocks(result);
	if (blocks.length === 0) {
		// Check if the result explicitly has an empty content array
		if (
			typeof result === "object" &&
			result !== null &&
			"content" in result &&
			Array.isArray(result.content) &&
			result.content.length === 0
		) {
			return [];
		}
		// Fallback to text extraction for results without content blocks
		const text = extractTextContent(result);
		if (text === "") return [];
		return [{ type: "content", content: { type: "text", text: markdownEscape(text) } }];
	}

	const content: ToolCallContent[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			content.push({
				type: "content",
				content: { type: "text", text: markdownEscape(block.text) },
			});
		}
		// Image blocks are preserved as-is (the ACP client handles rendering)
		// We skip them here since they need their original structure from the result
	}

	// If we only had image blocks and no text, return empty
	return content;
}

function formatLspContent(result: unknown): ToolCallContent[] {
	const text = extractTextContent(result);
	if (text === "") return [];
	return [{ type: "content", content: { type: "text", text: `\`\`\`\n${text}\n\`\`\`` } }];
}

function formatFallbackContent(result: unknown): ToolCallContent[] {
	const text = extractTextContent(result);
	if (text === "") return [];
	return [{ type: "content", content: { type: "text", text } }];
}

/**
 * Wrap streaming output text in a console code fence for bash/tmux.
 *
 * Each streaming update is self-contained (full accumulated buffer),
 * following the codex-acp pattern.
 */
export function wrapStreamingBashOutput(text: string): string {
	if (text === "") return "";
	return `\`\`\`console\n${text}\n\`\`\``;
}
