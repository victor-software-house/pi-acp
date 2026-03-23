/**
 * Detect whether the user has any pi authentication configured.
 *
 * Checks three sources:
 * 1. auth.json (API keys, OAuth credentials)
 * 2. models.json custom provider apiKey entries
 * 3. Known provider environment variables
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";

const modelsConfigSchema = z.object({
	providers: z
		.record(
			z.string().trim(),
			z.object({
				apiKey: z.string().trim().optional(),
			}),
		)
		.optional(),
});

function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env === undefined) return join(homedir(), ".pi", "agent");
	if (env === "~") return homedir();
	if (env.startsWith("~/")) return homedir() + env.slice(1);
	return env;
}

function readJsonFile(path: string): unknown {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf-8").trim();
		if (!raw) return null;
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function hasAuthJson(): boolean {
	const data = readJsonFile(join(agentDir(), "auth.json"));
	return typeof data === "object" && data !== null && Object.keys(data).length > 0;
}

function hasCustomProviderKey(): boolean {
	const raw = readJsonFile(join(agentDir(), "models.json"));
	const result = modelsConfigSchema.safeParse(raw);
	if (!result.success || !result.data.providers) return false;

	return Object.values(result.data.providers).some(
		(provider) => typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0,
	);
}

/** Environment variables that indicate a configured provider API key. */
const PROVIDER_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"HF_TOKEN",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
];

function hasProviderEnvVar(): boolean {
	return PROVIDER_ENV_VARS.some((key) => {
		const val = process.env[key];
		return typeof val === "string" && val.trim().length > 0;
	});
}

export function hasPiAuthConfigured(): boolean {
	return hasAuthJson() || hasCustomProviderKey() || hasProviderEnvVar();
}
