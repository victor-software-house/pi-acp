import { describe, expect, test } from "bun:test";
import { resolveModelPreference } from "@pi-acp/acp/model-alias";

const models = [
	{ provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
	{ provider: "anthropic", id: "claude-opus-4-20250514", name: "Claude Opus 4" },
	{
		provider: "anthropic",
		id: "claude-3-5-sonnet-20241022",
		name: "Claude 3.5 Sonnet",
	},
	{ provider: "openrouter", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
	{
		provider: "openrouter",
		id: "deepseek/deepseek-r1-0528",
		name: "DeepSeek R1",
	},
] as const;

describe("resolveModelPreference", () => {
	test("exact match on provider/id", () => {
		const result = resolveModelPreference(models, "anthropic/claude-opus-4-20250514");
		expect(result).toEqual({ provider: "anthropic", id: "claude-opus-4-20250514" });
	});

	test("exact match on id alone", () => {
		const result = resolveModelPreference(models, "claude-opus-4-20250514");
		expect(result).toEqual({ provider: "anthropic", id: "claude-opus-4-20250514" });
	});

	test("alias match: 'opus'", () => {
		const result = resolveModelPreference(models, "opus");
		expect(result).not.toBeNull();
		expect(result?.id).toContain("opus");
	});

	test("alias match: 'sonnet'", () => {
		const result = resolveModelPreference(models, "sonnet");
		expect(result).not.toBeNull();
		expect(result?.id).toContain("sonnet");
	});

	test("alias match: 'deepseek'", () => {
		const result = resolveModelPreference(models, "deepseek");
		expect(result).not.toBeNull();
		expect(result?.provider).toBe("openrouter");
	});

	test("alias match is case-insensitive", () => {
		const result = resolveModelPreference(models, "OPUS");
		expect(result).not.toBeNull();
		expect(result?.id).toContain("opus");
	});

	test("context hint: 'sonnet[3.5]' prefers 3.5 model", () => {
		const result = resolveModelPreference(models, "sonnet[3.5]");
		expect(result).not.toBeNull();
		expect(result?.id).toContain("3-5-sonnet");
	});

	test("returns null for unknown preference", () => {
		expect(resolveModelPreference(models, "gpt-4")).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(resolveModelPreference(models, "")).toBeNull();
	});

	test("returns null for whitespace-only", () => {
		expect(resolveModelPreference(models, "   ")).toBeNull();
	});

	test("returns null for empty model list", () => {
		expect(resolveModelPreference([], "opus")).toBeNull();
	});

	test("strips 'claude' from preference tokens", () => {
		// "claude opus" should still match opus since "claude" is stripped
		const result = resolveModelPreference(models, "claude opus");
		expect(result).not.toBeNull();
		expect(result?.id).toContain("opus");
	});

	test("exact provider/id match is case-insensitive", () => {
		const result = resolveModelPreference(models, "Anthropic/claude-opus-4-20250514");
		expect(result).toEqual({ provider: "anthropic", id: "claude-opus-4-20250514" });
	});
});
