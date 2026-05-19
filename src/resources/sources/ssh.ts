/**
 * SshBackend: reads resource files from a remote host via the system `ssh`
 * command. Honors the operator's `~/.ssh/config` (ProxyJump, ControlMaster,
 * agent forwarding) by design — we shell out to the real `ssh` binary
 * rather than re-implementing SFTP. PRD-002 §FR-2.
 *
 * Phase 6 scope: AGENTS files via explicit `paths.agentsFiles` list only.
 * Skills, prompts, and extensions emit a single "not yet implemented over
 * ssh" diagnostic each — they need either remote directory enumeration (no
 * `fs/listDir` analogue on the wire today) or an explicit file manifest,
 * both deferred to future phases.
 *
 * Timeout: pure ssh-protocol options — `-o ConnectTimeout=N` caps the TCP
 * + handshake phase; `-o ServerAliveInterval=2 -o ServerAliveCountMax=N`
 * caps post-auth silence on a stalled remote. ssh self-terminates without
 * any caller-side wrapper. Bun Shell `$` interpolations are auto-escaped;
 * `ShellPromise` has no `.timeout()` primitive (verified at runtime
 * against bun 1.3.14 — only `cwd/env/quiet/nothrow/throws/text/json/
 * lines/arrayBuffer/bytes/blob/run/then`), but ssh's own options cover
 * the 99% of real-world stall modes. See the `bun-shell` skill.
 */

import { $ } from "bun";

import type { PromptTemplate, ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import type { ResourceSource } from "@pi-acp/resources/sources/base";

export interface SshBackendPaths {
	skills?: string | undefined;
	prompts?: string | undefined;
	agentsFiles?: string[] | undefined;
	extensions?: string | undefined;
}

export interface SshBackendOptions {
	id: string;
	host: string;
	user?: string;
	paths?: SshBackendPaths;
	/** Per-operation timeout. Default 5_000ms per PRD-002 §FR-2. */
	timeoutMs?: number;
	/**
	 * ssh binary path. Defaults to `"ssh"` (resolved via PATH). Tests
	 * inject an absolute-path shim because Bun.spawn's PATH lookup does
	 * not honor runtime `process.env.PATH` mutations.
	 */
	sshCommand?: string;
}

interface AgentsFileCache {
	files: Array<{ path: string; content: string }>;
	diagnostics: ResourceDiagnostic[];
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class SshBackend implements ResourceSource {
	readonly id: string;
	readonly kind = "ssh" as const;
	private readonly host: string;
	private readonly user: string | undefined;
	private readonly paths: SshBackendPaths;
	private readonly timeoutMs: number;
	private readonly sshCommand: string;
	private cache: AgentsFileCache | null = null;

	constructor(opts: SshBackendOptions) {
		this.id = opts.id;
		this.host = opts.host;
		this.user = opts.user;
		this.paths = opts.paths ?? {};
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.sshCommand = opts.sshCommand ?? "ssh";
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
					this.cat(path).then(
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
					message: `pi-acp ssh source '${this.id}' (${this.target()}): agentsFile '${r.path}' unreadable — ${r.error ?? "(unknown)"}`,
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
		// Backend-level diagnostics (agentsFile failures, unsupported manifest
		// keys) surface here so they reach the operator through
		// VirtualResourceLoader's existing diagnostic aggregation path. Skills
		// over SSH are not implemented; the diagnostic for `paths.skills` is
		// already in this list when applicable.
		return { skills: [], diagnostics: this.cache?.diagnostics ?? [] };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: [], diagnostics: [] };
	}

	// `getExtensions` intentionally omitted — VirtualResourceLoader routes
	// extensions through the primary LocalBackend. Unsupported `paths.extensions`
	// surfaces as a diagnostic via `reload()` + `getSkills()`.

	getSystemPrompt(): string | undefined {
		return undefined;
	}

	getAppendSystemPrompt(): string[] {
		return [];
	}

	private target(): string {
		return this.user !== undefined && this.user.length > 0
			? `${this.user}@${this.host}`
			: this.host;
	}

	private qualifyPath(path: string): string {
		return `ssh://${this.target()}/${path.replace(/^\//, "")}`;
	}

	private unsupportedDiagnostic(kind: "skills" | "prompts" | "extensions"): ResourceDiagnostic {
		return {
			type: "warning",
			message: `pi-acp ssh source '${this.id}' (${this.target()}): ${kind} discovery over SSH not yet implemented — declare individual files via paths.agentsFiles for now, or omit paths.${kind}.`,
		};
	}

	private async cat(path: string): Promise<string> {
		const seconds = Math.max(1, Math.ceil(this.timeoutMs / 1000));
		const aliveCount = Math.max(1, Math.floor(seconds / 2));
		const result =
			await $`${this.sshCommand} -o BatchMode=yes -o ConnectTimeout=${seconds} -o ServerAliveInterval=2 -o ServerAliveCountMax=${aliveCount} ${this.target()} -- cat ${path}`
				.quiet()
				.nothrow();
		if (result.exitCode !== 0) {
			const stderr = result.stderr.toString().trim();
			throw new Error(`ssh exited ${result.exitCode}: ${stderr || "(no stderr)"}`);
		}
		return result.stdout.toString();
	}
}
