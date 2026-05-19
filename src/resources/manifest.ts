/**
 * Cascade resolver for the `.pi-acp.yaml` resource composition manifest
 * (ADR-0008, PRD-002 §FR-3).
 *
 * Precedence (highest first):
 *   1. ACP session params: `params._meta.piAcp.manifest`
 *      — either an inline manifest object or a string path to a YAML file
 *   2. Project-level: `<cwd>/.pi-acp.yaml`
 *   3. User-global:   `~/.pi-acp/config.yaml`
 *   4. Synthesized default
 *
 * Parse errors at any layer fall through to the next; the caller never gets
 * an exception. Errors collect into the returned `diagnostics` list so they
 * can be surfaced to the operator.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MANIFEST, type Manifest, ManifestSchema } from "@pi-acp/resources/manifest.schema";
import { parse as parseYaml } from "yaml";

export interface ManifestDiagnostic {
	source: "session-params" | "project" | "user-global" | "default";
	path?: string;
	message: string;
}

export interface LoadManifestInput {
	cwd: string;
	sessionParams?: unknown;
}

export interface LoadManifestResult {
	manifest: Manifest;
	source: ManifestDiagnostic["source"];
	path?: string;
	diagnostics: ManifestDiagnostic[];
}

const USER_MANIFEST_PATH = join(homedir(), ".pi-acp", "config.yaml");
const PROJECT_MANIFEST_BASENAME = ".pi-acp.yaml";

export async function loadManifest(input: LoadManifestInput): Promise<LoadManifestResult> {
	const diagnostics: ManifestDiagnostic[] = [];

	const fromParams = await tryFromSessionParams(input.sessionParams, diagnostics);
	if (fromParams !== null) {
		const result: LoadManifestResult = {
			manifest: fromParams.manifest,
			source: "session-params",
			diagnostics,
		};
		if (fromParams.path !== undefined) result.path = fromParams.path;
		return result;
	}

	const projectPath = join(input.cwd, PROJECT_MANIFEST_BASENAME);
	const fromProject = tryFromFile(projectPath, "project", diagnostics);
	if (fromProject !== null) {
		return { manifest: fromProject, source: "project", path: projectPath, diagnostics };
	}

	const fromUser = tryFromFile(USER_MANIFEST_PATH, "user-global", diagnostics);
	if (fromUser !== null) {
		return { manifest: fromUser, source: "user-global", path: USER_MANIFEST_PATH, diagnostics };
	}

	return { manifest: DEFAULT_MANIFEST, source: "default", diagnostics };
}

async function tryFromSessionParams(
	params: unknown,
	diagnostics: ManifestDiagnostic[],
): Promise<{ manifest: Manifest; path?: string } | null> {
	if (typeof params !== "object" || params === null) return null;
	const meta = (params as { _meta?: unknown })._meta;
	if (typeof meta !== "object" || meta === null) return null;
	const piAcp = (meta as { piAcp?: unknown }).piAcp;
	if (typeof piAcp !== "object" || piAcp === null) return null;
	const manifestRef = (piAcp as { manifest?: unknown }).manifest;
	if (manifestRef === undefined) return null;

	if (typeof manifestRef === "string") {
		const parsed = tryFromFile(manifestRef, "session-params", diagnostics);
		if (parsed !== null) return { manifest: parsed, path: manifestRef };
		return null;
	}

	const result = ManifestSchema.safeParse(manifestRef);
	if (result.success) return { manifest: result.data };
	diagnostics.push({
		source: "session-params",
		message: `inline manifest validation failed: ${result.error.message}`,
	});
	return null;
}

function tryFromFile(
	path: string,
	source: ManifestDiagnostic["source"],
	diagnostics: ManifestDiagnostic[],
): Manifest | null {
	if (!existsSync(path)) return null;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		diagnostics.push({
			source,
			path,
			message: `read failed: ${err instanceof Error ? err.message : String(err)}`,
		});
		return null;
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		diagnostics.push({
			source,
			path,
			message: `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
		});
		return null;
	}
	const result = ManifestSchema.safeParse(parsed);
	if (result.success) return result.data;
	diagnostics.push({
		source,
		path,
		message: `schema validation failed: ${result.error.message}`,
	});
	return null;
}
