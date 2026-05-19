/**
 * Common interface every resource backend implements. Each source contributes
 * its own resource set; VirtualResourceLoader composes them.
 *
 * Phase 4 (this commit) ships only the LocalBackend. SSH / HTTP / ACP-FS
 * backends land in later phases against this same interface.
 */

import type {
	LoadExtensionsResult,
	PromptTemplate,
	ResourceDiagnostic,
	Skill,
} from "@earendil-works/pi-coding-agent";

export type ResourceSourceKind = "local" | "acp-fs" | "ssh" | "http";

export interface ResourceSource {
	readonly id: string;
	readonly kind: ResourceSourceKind;
	/**
	 * Force-refresh the source's view of its underlying storage. For local
	 * backends this re-walks the filesystem; for remote backends this clears
	 * the in-memory cache so the next get*() call re-fetches.
	 */
	reload(): Promise<void>;
	getAgentsFiles(): Array<{ path: string; content: string }>;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	/**
	 * Optional. VirtualResourceLoader routes `extensions` through the
	 * designated primary LocalBackend only; remote sources (ssh, http,
	 * acp-fs) leave this undefined.
	 */
	getExtensions?(): LoadExtensionsResult;
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
}
