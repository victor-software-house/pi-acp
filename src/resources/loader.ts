/**
 * VirtualResourceLoader: implements pi's ResourceLoader interface as a
 * composer over multiple ResourceSource instances.
 *
 * Phase 4 ships the skeleton with a single LocalBackend default — behaviour
 * identical to v0.5's bare `createAgentSession({ cwd })` (which auto-builds a
 * DefaultResourceLoader). The point of going through this layer now is to
 * make Phase 5+ additive: manifest declares additional sources; loader
 * aggregates without changing PiAcpAgent's wire shape.
 */

import type {
	LoadExtensionsResult,
	PromptTemplate,
	ResourceDiagnostic,
	ResourceLoader,
	Skill,
} from "@earendil-works/pi-coding-agent";
import type { ResourceSource } from "@pi-acp/resources/sources/base";
import { LocalBackend } from "@pi-acp/resources/sources/local";

/** Mirrors pi's internal ResourceExtensionPaths (not re-exported from package root). */
type ResourceExtensionPaths = Parameters<ResourceLoader["extendResources"]>[0];

export type MergeStrategy = "append" | "override-by-name";

export interface VirtualResourceLoaderOptions {
	sources: ResourceSource[];
	mergeStrategy?: MergeStrategy;
	/**
	 * One source designated as primary supplies extensions + runtime.
	 * Defaults to the first local source. Must satisfy the LocalBackend
	 * interface contract for extensions / themes.
	 */
	primarySourceId?: string;
}

export class VirtualResourceLoader implements ResourceLoader {
	private readonly sources: ResourceSource[];
	private readonly mergeStrategy: MergeStrategy;
	private readonly primary: LocalBackend;

	constructor(opts: VirtualResourceLoaderOptions) {
		if (opts.sources.length === 0) {
			throw new Error("VirtualResourceLoader requires at least one source");
		}
		this.sources = opts.sources;
		this.mergeStrategy = opts.mergeStrategy ?? "append";
		const primary = resolvePrimary(opts.sources, opts.primarySourceId);
		this.primary = primary;
	}

	async reload(): Promise<void> {
		await Promise.all(this.sources.map((s) => s.reload()));
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		const seen = new Set<string>();
		const merged: Array<{ path: string; content: string }> = [];
		for (const source of this.sources) {
			for (const file of source.getAgentsFiles()) {
				if (seen.has(file.path)) continue;
				seen.add(file.path);
				merged.push(file);
			}
		}
		return { agentsFiles: merged };
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		const merge = createMerger<Skill>(this.mergeStrategy, (s) => s.name);
		const diagnostics: ResourceDiagnostic[] = [];
		for (const source of this.sources) {
			const result = source.getSkills();
			merge.absorb(result.skills);
			diagnostics.push(...result.diagnostics);
		}
		return { skills: merge.list(), diagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		const merge = createMerger<PromptTemplate>(this.mergeStrategy, (p) => p.name);
		const diagnostics: ResourceDiagnostic[] = [];
		for (const source of this.sources) {
			const result = source.getPrompts();
			merge.absorb(result.prompts);
			diagnostics.push(...result.diagnostics);
		}
		return { prompts: merge.list(), diagnostics };
	}

	getThemes(): {
		themes: ReturnType<ResourceLoader["getThemes"]>["themes"];
		diagnostics: ResourceDiagnostic[];
	} {
		return this.primary.inner().getThemes();
	}

	getExtensions(): LoadExtensionsResult {
		// Pi's extension runtime is owned by the primary backend's
		// DefaultResourceLoader. Multi-source extension composition is
		// out of scope for v0.6.
		return this.primary.getExtensions();
	}

	getSystemPrompt(): string | undefined {
		for (const source of this.sources) {
			const sp = source.getSystemPrompt();
			if (sp !== undefined) return sp;
		}
		return undefined;
	}

	getAppendSystemPrompt(): string[] {
		const merged: string[] = [];
		for (const source of this.sources) merged.push(...source.getAppendSystemPrompt());
		return merged;
	}

	extendResources(paths: ResourceExtensionPaths): void {
		// Forward to the primary backend's underlying DefaultResourceLoader.
		this.primary.inner().extendResources(paths);
	}

	/** Returns the active source list. Useful for diagnostics. */
	listSources(): ResourceSource[] {
		return [...this.sources];
	}
}

function resolvePrimary(sources: ResourceSource[], preferredId: string | undefined): LocalBackend {
	if (preferredId !== undefined) {
		const found = sources.find((s) => s.id === preferredId);
		if (found === undefined) {
			throw new Error(`VirtualResourceLoader: primarySourceId "${preferredId}" not in sources`);
		}
		if (!(found instanceof LocalBackend)) {
			throw new Error(
				`VirtualResourceLoader: primary source "${preferredId}" must be a LocalBackend`,
			);
		}
		return found;
	}
	const firstLocal = sources.find((s): s is LocalBackend => s instanceof LocalBackend);
	if (firstLocal === undefined) {
		throw new Error(
			"VirtualResourceLoader: at least one LocalBackend is required (for extensions + themes)",
		);
	}
	return firstLocal;
}

interface Merger<T> {
	absorb(items: T[]): void;
	list(): T[];
}

function createMerger<T>(strategy: MergeStrategy, key: (item: T) => string): Merger<T> {
	if (strategy === "append") {
		const out: T[] = [];
		return {
			absorb(items) {
				out.push(...items);
			},
			list() {
				return out;
			},
		};
	}
	const byKey = new Map<string, T>();
	return {
		absorb(items) {
			for (const item of items) byKey.set(key(item), item);
		},
		list() {
			return Array.from(byKey.values());
		},
	};
}
