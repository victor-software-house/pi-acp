/**
 * PRD-002 §FR-7 — opt-in diagnostics surface.
 *
 * When the manifest sets `diagnostics: true`, pi-acp emits a one- or
 * two-paragraph summary at session start (before any model output) listing
 * every resource source and any reload failures. Pure formatting — no
 * side effects on the loader or session state.
 *
 * Surface choice: the agent emits this as an `agent_message_chunk` on the
 * first prompt of the session (chosen per PRD §FR-7 acceptance). It lives
 * at the session boundary, never interleaved with model text.
 */

import type { ManifestDiagnostic } from "@pi-acp/resources/manifest";
import type { ResourceSource } from "@pi-acp/resources/sources/base";

export interface DiagnosticsInput {
	sources: ResourceSource[];
	/**
	 * Manifest-level diagnostics (parse failures, unsupported root kinds,
	 * etc.) collected during `buildResourceLoader`.
	 */
	manifestDiagnostics: ManifestDiagnostic[];
}

export interface DiagnosticsReport {
	/**
	 * Full multi-line summary. Empty string when there's nothing to say
	 * (no manifest diagnostics + every source contributed zero failures).
	 */
	text: string;
	/** Per-source stat counts, exposed for tests. */
	sourceStats: Array<{
		id: string;
		kind: ResourceSource["kind"];
		agentsFiles: number;
		skills: number;
		prompts: number;
		failures: string[];
	}>;
}

export function buildDiagnosticsReport(input: DiagnosticsInput): DiagnosticsReport {
	const sourceStats = input.sources.map((source) => {
		const skills = source.getSkills();
		const prompts = source.getPrompts();
		const failures = skills.diagnostics
			.filter((d) => d.type === "warning" || d.type === "error")
			.map((d) => d.message);
		return {
			id: source.id,
			kind: source.kind,
			agentsFiles: source.getAgentsFiles().length,
			skills: skills.skills.length,
			prompts: prompts.prompts.length,
			failures,
		};
	});

	const lines: string[] = [];
	if (sourceStats.length > 0) {
		lines.push("[pi-acp] resources active:");
		for (const s of sourceStats) {
			lines.push(
				`  ${s.id.padEnd(20)} kind=${s.kind} (${s.agentsFiles} AGENTS files, ${s.skills} skills, ${s.prompts} prompts)`,
			);
		}
	}

	const allFailures: string[] = [];
	for (const s of sourceStats) {
		for (const f of s.failures) allFailures.push(`  ${s.id.padEnd(20)} ${f}`);
	}
	for (const d of input.manifestDiagnostics) {
		const where = d.path !== undefined ? ` ${d.path}` : "";
		allFailures.push(`  manifest[${d.source}${where}] ${d.message}`);
	}
	if (allFailures.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("[pi-acp] resource failures:");
		lines.push(...allFailures);
	}

	return { text: lines.join("\n"), sourceStats };
}
