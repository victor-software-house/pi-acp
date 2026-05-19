/**
 * LocalBackend: wraps pi's DefaultResourceLoader for one (cwd, agentDir) root.
 * Phase 4 skeleton — manifest support (multiple local roots) lands in Phase 5.
 */

import {
	DefaultResourceLoader,
	type LoadExtensionsResult,
	type PromptTemplate,
	type ResourceDiagnostic,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { ResourceSource } from "@pi-acp/resources/sources/base";

export interface LocalBackendOptions {
	id?: string;
	cwd: string;
	agentDir: string;
}

export class LocalBackend implements ResourceSource {
	readonly id: string;
	readonly kind = "local" as const;
	private readonly loader: DefaultResourceLoader;

	constructor(opts: LocalBackendOptions) {
		this.id = opts.id ?? "local";
		this.loader = new DefaultResourceLoader({ cwd: opts.cwd, agentDir: opts.agentDir });
	}

	async reload(): Promise<void> {
		await this.loader.reload();
	}

	getAgentsFiles(): Array<{ path: string; content: string }> {
		return this.loader.getAgentsFiles().agentsFiles;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return this.loader.getSkills();
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return this.loader.getPrompts();
	}

	getExtensions(): LoadExtensionsResult {
		return this.loader.getExtensions();
	}

	getSystemPrompt(): string | undefined {
		return this.loader.getSystemPrompt();
	}

	getAppendSystemPrompt(): string[] {
		return this.loader.getAppendSystemPrompt();
	}

	/**
	 * Expose the wrapped DefaultResourceLoader for VirtualResourceLoader's
	 * extension/theme passthrough. Other backends don't expose this.
	 */
	inner(): DefaultResourceLoader {
		return this.loader;
	}
}
