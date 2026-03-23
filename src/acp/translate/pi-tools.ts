/**
 * Extract displayable text from a pi tool result.
 *
 * Pi tool results have varying shapes depending on the tool. This function
 * tries content blocks first, then falls back to details fields (diff, stdout/stderr),
 * and finally JSON serialization as a last resort.
 */

import * as z from "zod";

const textBlockSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

const toolDetailsSchema = z.object({
	diff: z.string().optional(),
	stdout: z.string().optional(),
	stderr: z.string().optional(),
	output: z.string().optional(),
	exitCode: z.number().optional(),
	code: z.number().optional(),
});

const toolResultSchema = z.object({
	content: z.array(z.unknown()).optional(),
	details: toolDetailsSchema.optional(),
	stdout: z.string().optional(),
	stderr: z.string().optional(),
	output: z.string().optional(),
	exitCode: z.number().optional(),
	code: z.number().optional(),
});

export function toolResultToText(result: unknown): string {
	if (result === null || result === undefined || typeof result !== "object") return "";

	const parsed = toolResultSchema.safeParse(result);
	if (!parsed.success) {
		try {
			return JSON.stringify(result, null, 2);
		} catch {
			return String(result);
		}
	}

	const r = parsed.data;

	if (r.content !== undefined) {
		const texts = r.content
			.map((block) => textBlockSchema.safeParse(block))
			.filter((res) => res.success)
			.map((res) => res.data.text);
		if (texts.length > 0) return texts.join("");
	}

	const d = r.details;

	const diff = d?.diff;
	if (diff !== undefined && diff.trim() !== "") return diff;

	const stdout = d?.stdout ?? r.stdout ?? d?.output ?? r.output;
	const stderr = d?.stderr ?? r.stderr;
	const exitCode = d?.exitCode ?? r.exitCode ?? d?.code ?? r.code;

	const hasStdout = stdout !== undefined && stdout.trim() !== "";
	const hasStderr = stderr !== undefined && stderr.trim() !== "";

	if (hasStdout || hasStderr) {
		const parts: string[] = [];
		if (hasStdout) parts.push(stdout);
		if (hasStderr) parts.push(`stderr:\n${stderr}`);
		if (exitCode !== undefined) parts.push(`exit code: ${exitCode}`);
		return parts.join("\n\n").trimEnd();
	}

	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}
