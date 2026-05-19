/**
 * HttpBackend: reads resource files from a remote HTTPS endpoint.
 *
 * Phase 7 scope: AGENTS files via explicit `paths.agentsFiles` list only.
 * Skills, prompts, and extensions emit a "not yet implemented over http"
 * diagnostic each — they need either an explicit file manifest or a
 * directory-listing convention that no public CDN ships natively.
 *
 * HTTPS-only at construction (defensive — manifest schema also enforces).
 * Per-URL in-memory TTL cache (default 300 s) survives across reload() calls
 * so repeated session bootstraps within the TTL window skip the network.
 * Per-request timeout via AbortController; default 5_000 ms per PRD-002 §FR-2.
 *
 * No write semantics. No redirect chasing beyond `fetch`'s default behavior
 * (follow). No auth — public URLs only; private resources should be exposed
 * via SSH or a future authed-fetch source.
 */

import type { PromptTemplate, ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import type { ResourceSource } from "@pi-acp/resources/sources/base";

export interface HttpBackendPaths {
	skills?: string | undefined;
	prompts?: string | undefined;
	agentsFiles?: string[] | undefined;
	extensions?: string | undefined;
}

export interface HttpBackendOptions {
	id: string;
	baseUrl: string;
	paths?: HttpBackendPaths;
	/** Cache TTL in seconds. Default 300 per PRD-002 §FR-2. */
	cacheTtlSeconds?: number;
	/** Per-request timeout in ms. Default 5_000. */
	timeoutMs?: number;
	/**
	 * `fetch` impl override. Tests inject a stub. Defaults to the global
	 * `fetch` bound to `globalThis`.
	 */
	fetchImpl?: typeof fetch;
}

interface UrlCacheEntry {
	content: string;
	expiresAt: number;
}

interface AgentsFileCache {
	files: Array<{ path: string; content: string }>;
	diagnostics: ResourceDiagnostic[];
}

const DEFAULT_CACHE_TTL_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 5_000;

export class HttpBackend implements ResourceSource {
	readonly id: string;
	readonly kind = "http" as const;
	private readonly baseUrl: string;
	private readonly paths: HttpBackendPaths;
	private readonly cacheTtlMs: number;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly urlCache = new Map<string, UrlCacheEntry>();
	private cache: AgentsFileCache | null = null;

	constructor(opts: HttpBackendOptions) {
		if (!opts.baseUrl.startsWith("https://")) {
			throw new Error(
				`pi-acp http source '${opts.id}': baseUrl must use https:// (got "${opts.baseUrl}")`,
			);
		}
		this.id = opts.id;
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.paths = opts.paths ?? {};
		this.cacheTtlMs = (opts.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS) * 1000;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	async reload(): Promise<void> {
		const diagnostics: ResourceDiagnostic[] = [];
		for (const kind of ["skills", "prompts", "extensions"] as const) {
			if (this.paths[kind] !== undefined) {
				diagnostics.push(this.unsupportedDiagnostic(kind));
			}
		}
		const list = this.paths.agentsFiles ?? [];
		const files: Array<{ path: string; content: string }> = [];
		if (list.length > 0) {
			const results = await Promise.all(
				list.map((path) =>
					this.fetchPath(path).then(
						(content) => ({ path, content, error: null as string | null }),
						(err: unknown) => ({
							path,
							content: null as string | null,
							error: err instanceof Error ? err.message : String(err),
						}),
					),
				),
			);
			for (const r of results) {
				if (r.content !== null) {
					files.push({ path: this.qualifyPath(r.path), content: r.content });
					continue;
				}
				diagnostics.push({
					type: "warning",
					message: `pi-acp http source '${this.id}' (${this.baseUrl}): agentsFile '${r.path}' unreadable — ${r.error ?? "(unknown)"}`,
					path: r.path,
				});
			}
		}
		this.cache = { files, diagnostics };
	}

	getAgentsFiles(): Array<{ path: string; content: string }> {
		return this.cache?.files ?? [];
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: [], diagnostics: this.cache?.diagnostics ?? [] };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: [], diagnostics: [] };
	}

	// `getExtensions` omitted — VirtualResourceLoader routes extensions
	// through the primary LocalBackend. Unsupported `paths.extensions`
	// surfaces as a diagnostic via reload() + getSkills().

	getSystemPrompt(): string | undefined {
		return undefined;
	}

	getAppendSystemPrompt(): string[] {
		return [];
	}

	private qualifyPath(path: string): string {
		return `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
	}

	private unsupportedDiagnostic(kind: "skills" | "prompts" | "extensions"): ResourceDiagnostic {
		return {
			type: "warning",
			message: `pi-acp http source '${this.id}' (${this.baseUrl}): ${kind} discovery over HTTP not yet implemented — declare individual files via paths.agentsFiles for now, or omit paths.${kind}.`,
		};
	}

	private async fetchPath(path: string): Promise<string> {
		const url = this.qualifyPath(path);
		const now = Date.now();
		const cached = this.urlCache.get(url);
		if (cached !== undefined && cached.expiresAt > now) {
			return cached.content;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let response: Response;
		try {
			response = await this.fetchImpl(url, { signal: controller.signal });
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(`fetch timed out after ${this.timeoutMs}ms`);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
		}
		const content = await response.text();
		this.urlCache.set(url, { content, expiresAt: now + this.cacheTtlMs });
		return content;
	}
}
