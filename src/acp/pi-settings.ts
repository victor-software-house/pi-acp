/**
 * Read pi settings from global and project config files.
 *
 * Settings are merged: project overrides global.
 * Paths follow pi-mono conventions:
 *   Global: ~/.pi/agent/settings.json
 *   Project: <cwd>/.pi/settings.json
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod";

const piSettingsSchema = z.object({
	enableSkillCommands: z.boolean().optional(),
	quietStartup: z.boolean().optional(),
	quietStart: z.boolean().optional(),
	skills: z
		.object({
			enableSkillCommands: z.boolean().optional(),
		})
		.optional(),
});

type PiSettings = z.infer<typeof piSettingsSchema>;

function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}

function merge(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, val] of Object.entries(override)) {
		const existing = result[key];
		if (isRecord(existing) && isRecord(val)) {
			result[key] = merge(existing, val);
		} else {
			result[key] = val;
		}
	}
	return result;
}

function readJson(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isRecord(data) ? data : {};
	} catch {
		return {};
	}
}

export function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR !== undefined
		? resolve(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
}

function resolvedSettings(cwd: string): PiSettings {
	const globalPath = join(piAgentDir(), "settings.json");
	const projectPath = resolve(cwd, ".pi", "settings.json");
	const merged = merge(readJson(globalPath), readJson(projectPath));
	const result = piSettingsSchema.safeParse(merged);
	return result.success ? result.data : {};
}

export function skillCommandsEnabled(cwd: string): boolean {
	const settings = resolvedSettings(cwd);

	if (typeof settings.enableSkillCommands === "boolean") {
		return settings.enableSkillCommands;
	}

	if (typeof settings.skills?.enableSkillCommands === "boolean") {
		return settings.skills.enableSkillCommands;
	}

	return true;
}

export function quietStartupEnabled(cwd: string): boolean {
	const settings = resolvedSettings(cwd);

	if (typeof settings.quietStartup === "boolean") {
		return settings.quietStartup;
	}

	if (typeof settings.quietStart === "boolean") {
		return settings.quietStart;
	}

	return false;
}
