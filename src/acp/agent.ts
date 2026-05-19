import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type Agent as ACPAgent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AvailableCommand,
	type CancelNotification,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type DeleteSessionRequest,
	type DeleteSessionResponse,
	type DisableProvidersRequest,
	type DisableProvidersResponse,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListProvidersRequest,
	type ListProvidersResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type ModelInfo,
	type NewSessionRequest,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionConfigOption,
	type SessionInfo,
	type SessionModelState,
	type SessionModeState,
	type SetProvidersRequest,
	type SetProvidersResponse,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModelRequest,
	type SetSessionModelResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
	type StopReason,
} from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionResult,
	createAgentSession,
	createBashToolDefinition,
	createReadToolDefinition,
	getAgentDir,
	SessionManager as PiSessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAcpBashOperations } from "@pi-acp/acp/acp-bash-operations";
import { createAcpReadOperations } from "@pi-acp/acp/acp-read-operations";
import { buildAuthMethods } from "@pi-acp/acp/auth";
import { detectAuthError } from "@pi-acp/acp/auth-required";
import {
	type ClientCapabilityFlags,
	parseClientCapabilities,
} from "@pi-acp/acp/client-capabilities";
import { ExtMethodDispatcher } from "@pi-acp/acp/ext-methods";
import { resolveModelPreference } from "@pi-acp/acp/model-alias";
import { skillCommandsEnabled } from "@pi-acp/acp/pi-settings";
import {
	applyDisableProvider,
	applySetProvider,
	buildListProvidersResponse,
} from "@pi-acp/acp/providers";
import {
	buildToolTitle,
	PiAcpSession,
	resolveToolPath,
	SessionManager,
	type ToolArgs,
	toToolArgs,
	toToolKind,
} from "@pi-acp/acp/session";
import { extractUserMessageText } from "@pi-acp/acp/translate/pi-messages";
import { acpPromptToPiMessage } from "@pi-acp/acp/translate/prompt";
import { formatToolContent } from "@pi-acp/acp/translate/tool-content";
import { piChangelogPath } from "@pi-acp/pi-package";
import { buildDiagnosticsReport } from "@pi-acp/resources/diagnostics";
import { VirtualResourceLoader } from "@pi-acp/resources/loader";
import { loadManifest, type ManifestDiagnostic } from "@pi-acp/resources/manifest";
import { type ResolveModeResult, resolveMode } from "@pi-acp/resources/modes";
import type { ResourceSource } from "@pi-acp/resources/sources/base";
import { HttpBackend } from "@pi-acp/resources/sources/http";
import { LocalBackend } from "@pi-acp/resources/sources/local";
import { SshBackend } from "@pi-acp/resources/sources/ssh";

import pkgJson from "../../package.json" with { type: "json" };

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Builtin ACP slash commands handled directly by the adapter. */
const BUILTIN_COMMANDS: readonly AvailableCommand[] = [
	{
		name: "compact",
		description: "Manually compact the session context",
		input: { hint: "optional custom instructions" },
	},
	{
		name: "autocompact",
		description: "Toggle automatic context compaction",
		input: { hint: "on|off|toggle" },
	},
	{ name: "export", description: "Export session to an HTML file in the session cwd" },
	{ name: "session", description: "Show session stats (messages, tokens, cost, session file)" },
	{ name: "name", description: "Set session display name", input: { hint: "<name>" } },
	{
		name: "steering",
		description: "Get/set pi steering message delivery mode",
		input: { hint: "(no args to show) all | one-at-a-time" },
	},
	{
		name: "follow-up",
		description: "Get/set pi follow-up message delivery mode",
		input: { hint: "(no args to show) all | one-at-a-time" },
	},
	{ name: "changelog", description: "Show pi changelog" },
] as const;

/**
 * Deduplicate commands by name. First occurrence wins.
 */
function deduplicateCommands(commands: AvailableCommand[]): AvailableCommand[] {
	const seen = new Set<string>();
	const out: AvailableCommand[] = [];
	for (const c of commands) {
		if (seen.has(c.name)) continue;
		seen.add(c.name);
		out.push(c);
	}
	return out;
}

function parseArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: string | null = null;

	for (const ch of input) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === " " || ch === "\t") {
			if (current !== "") {
				args.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}

	if (current !== "") args.push(current);
	return args;
}

const SESSION_TITLE_MAX = 100;

function truncateSessionTitle(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === "") return null;
	const oneLine = trimmed.replace(/\n/g, " ");
	if (oneLine.length <= SESSION_TITLE_MAX) return oneLine;
	return `${oneLine.slice(0, SESSION_TITLE_MAX - 1)}…`;
}

export class PiAcpAgent implements ACPAgent {
	private readonly conn: AgentSideConnection;
	private readonly sessions = new SessionManager();
	/** Cache of sessionId → file path, populated by listSessions and newSession. */
	private readonly sessionPaths = new Map<string, string>();
	/** Parsed client capability flags from initialize(). */
	private clientCapabilities: ClientCapabilityFlags = {
		terminalOutput: false,
		terminalAuth: false,
		gatewayAuth: false,
		fsReadTextFile: false,
		terminal: false,
	};

	private readonly daemonContext: import("@pi-acp/daemon/context").DaemonContext | undefined;
	/** Unique ID for this ACP connection. Used as the ownership key in the daemon SessionRegistry. */
	private readonly connectionId = randomUUID();
	private readonly extMethods: ExtMethodDispatcher;
	private readonly startedAt = Date.now();
	/**
	 * pi-acp-side soft-disable set for providers. Pi has only `unregister`
	 * (destructive); we layer a disabled-set on top so `listProviders` can
	 * report `current: null` per ACP spec even after disable.
	 */
	private readonly disabledProviders = new Set<string>();

	dispose(): void {
		// On connection close, release every session this connection owned or
		// resumed from the daemon registry. Sessions another client still holds
		// stay live; sessions only this connection held get disposed by release().
		if (this.daemonContext !== undefined) {
			const registry = this.daemonContext.sessionRegistry;
			for (const entry of registry.listOwnedBy(this.connectionId)) {
				const result = registry.release(entry.sessionId, this.connectionId);
				if (result.kind === "disposed") {
					try {
						entry.piSession.dispose();
					} catch {
						/* best-effort */
					}
				}
			}
		}
		this.sessions.disposeAll();
	}

	constructor(
		conn: AgentSideConnection,
		daemonContext?: import("@pi-acp/daemon/context").DaemonContext,
	) {
		this.conn = conn;
		this.daemonContext = daemonContext;
		this.extMethods = new ExtMethodDispatcher({
			version: pkgJson.version,
			startedAt: this.startedAt,
			sessionCount: () => this.sessions.size(),
		});
	}

	async extMethod(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return this.extMethods.handleRequest(method, params);
	}

	async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
		await this.extMethods.handleNotification(method, params);
	}

	/**
	 * Iterable of every live `ModelRegistry` instance — local SessionManager
	 * plus daemon SessionRegistry. Used by the providers/* methods to apply
	 * mutations across all live sessions.
	 */
	private liveModelRegistries(): Iterable<import("@earendil-works/pi-coding-agent").ModelRegistry> {
		const out: import("@earendil-works/pi-coding-agent").ModelRegistry[] = [];
		for (const s of this.sessions.values()) out.push(s.piSession.modelRegistry);
		if (this.daemonContext !== undefined) {
			for (const e of this.daemonContext.sessionRegistry.listAll()) {
				out.push(e.piSession.modelRegistry);
			}
		}
		return out;
	}

	async unstable_listProviders(_params: ListProvidersRequest): Promise<ListProvidersResponse> {
		return buildListProvidersResponse({
			registries: () => this.liveModelRegistries(),
			disabled: this.disabledProviders,
		});
	}

	async unstable_setProvider(params: SetProvidersRequest): Promise<SetProvidersResponse> {
		if (params.id === "") {
			throw RequestError.invalidParams("provider id must be non-empty");
		}
		return applySetProvider(
			{ registries: () => this.liveModelRegistries(), disabled: this.disabledProviders },
			params,
		);
	}

	async unstable_disableProvider(
		params: DisableProvidersRequest,
	): Promise<DisableProvidersResponse> {
		if (params.id === "") {
			throw RequestError.invalidParams("provider id must be non-empty");
		}
		return applyDisableProvider(
			{ registries: () => this.liveModelRegistries(), disabled: this.disabledProviders },
			params,
		);
	}

	private registerWithDaemon(input: {
		sessionId: string;
		piSession: AgentSession;
		cwd: string;
		sessionFile: string | undefined;
	}): void {
		if (this.daemonContext === undefined) return;
		this.daemonContext.sessionRegistry.register({
			sessionId: input.sessionId,
			piSession: input.piSession,
			ownerConnectionId: this.connectionId,
			cwd: input.cwd,
			sessionFile: input.sessionFile,
		});
	}

	private releaseFromDaemon(sessionId: string): { disposed: boolean } {
		if (this.daemonContext === undefined) return { disposed: true };
		const result = this.daemonContext.sessionRegistry.release(sessionId, this.connectionId);
		return { disposed: result.kind === "disposed" };
	}

	/**
	 * Build a VirtualResourceLoader for a new pi session. Reads the
	 * `.pi-acp.yaml` manifest cascade (ACP params > project > user-global >
	 * default), turns each declared root into a ResourceSource, and ensures at
	 * least one LocalBackend is present for the extension / theme passthrough.
	 *
	 * Phase 5 materializes `kind: "local"`. Phase 6 adds `kind: "ssh"`.
	 * Phase 7 adds `kind: "http"`. `acp-fs` still parses fine but surfaces as
	 * a diagnostic until its backend lands in a subsequent phase.
	 */
	private async buildResourceLoader(
		cwd: string,
		sessionParams?: unknown,
		opts?: { resolveCwdMode?: boolean },
	): Promise<{
		loader: VirtualResourceLoader;
		modeResult: ResolveModeResult;
		diagnosticsEnabled: boolean;
		manifestDiagnostics: ManifestDiagnostic[];
	}> {
		const loaded = await loadManifest({ cwd, sessionParams });
		// Mode resolution mints a tmpdir for `mode: none`. Load/resume/fork
		// paths pin cwd from the session file, so mode is irrelevant on those
		// paths — passing { resolveCwdMode: false } avoids the leaked
		// tmpdir + the cwd-mismatch (manifest tmpdir vs session-file cwd).
		const shouldResolveMode = opts?.resolveCwdMode !== false;
		const modeResult: ResolveModeResult = shouldResolveMode
			? resolveMode({ manifest: loaded.manifest, requestedCwd: cwd })
			: { mode: loaded.manifest.mode, cwd, cleanup: () => {}, ephemeral: false };
		const effectiveCwd = modeResult.cwd;
		const diagnostics: ManifestDiagnostic[] = [...loaded.diagnostics];
		const sources: ResourceSource[] = [];

		for (const root of loaded.manifest.roots) {
			if (root.kind === "local") {
				sources.push(
					new LocalBackend({
						id: root.id,
						cwd: root.paths.cwd ?? effectiveCwd,
						agentDir: root.paths.agentDir ?? getAgentDir(),
					}),
				);
				continue;
			}
			if (root.kind === "ssh") {
				const sshOpts: ConstructorParameters<typeof SshBackend>[0] = {
					id: root.id,
					host: root.host,
					paths: root.paths,
				};
				if (root.user !== undefined) sshOpts.user = root.user;
				sources.push(new SshBackend(sshOpts));
				continue;
			}
			if (root.kind === "http") {
				const httpOpts: ConstructorParameters<typeof HttpBackend>[0] = {
					id: root.id,
					baseUrl: root.baseUrl,
					paths: root.paths,
				};
				if (root.cache !== undefined) httpOpts.cacheTtlSeconds = root.cache.ttl;
				sources.push(new HttpBackend(httpOpts));
				continue;
			}
			const diag: ManifestDiagnostic = {
				source: loaded.source,
				message: `root "${root.id}" kind="${root.kind}" not yet supported in this build (skipped)`,
			};
			if (loaded.path !== undefined) diag.path = loaded.path;
			diagnostics.push(diag);
		}

		// VirtualResourceLoader needs at least one LocalBackend for extensions
		// + themes. Synthesize one from the effective cwd if the manifest
		// didn't already declare one. In `none` mode the effective cwd is the
		// ephemeral tmpdir, so the synthesized backend sees a clean root.
		if (!sources.some((s) => s.kind === "local")) {
			sources.unshift(new LocalBackend({ cwd: effectiveCwd, agentDir: getAgentDir() }));
		}

		const loader = new VirtualResourceLoader({
			sources,
			mergeStrategy: loaded.manifest.mergeStrategy,
		});
		await loader.reload();

		// Phase 11 will surface these via session/update. Until then, log
		// them to stderr under the daemon-debug flag so a malformed manifest
		// doesn't fail silently.
		// biome-ignore lint/complexity/useLiteralKeys: env var keys need bracket access for tsc strict mode
		if (diagnostics.length > 0 && process.env["PI_ACP_DAEMON_DEBUG"] === "1") {
			for (const d of diagnostics) {
				const where = d.path !== undefined ? ` ${d.path}` : "";
				process.stderr.write(`pi-acp manifest [${d.source}${where}]: ${d.message}\n`);
			}
		}
		return {
			loader,
			modeResult,
			diagnosticsEnabled: loaded.manifest.diagnostics === true,
			manifestDiagnostics: diagnostics,
		};
	}

	/**
	 * PRD-002 §FR-6 + §FR-6.5 — tool overrides for ACP-FS read + ACP terminal bash.
	 *
	 * For each tool we override, the allowlist MUST include the original
	 * tool name so pi's customTool registration loop (which filters by
	 * name) can register the override; the override then shadows the
	 * builtin via the tool-definition `Map.set` path inside AgentSession
	 * (verified against pi source — agent-session.js:1811).
	 *
	 * SessionId binding is late: pi mints the id inside `createAgentSession`
	 * (after `customTools` is built), so we share a single mutable ref
	 * across all overrides. The caller mutates `sessionIdRef.current`
	 * right after createAgentSession returns, before any model turn — the
	 * tools aren't invoked until prompt-time, so the late binding is safe.
	 *
	 * Returns `null` when neither capability is advertised; callers skip
	 * the overlay and pi's built-in tools handle everything locally.
	 */
	private buildAcpToolOverlay(cwd: string): {
		sessionIdRef: { current: string };
		tools: string[];
		customTools: ToolDefinition[];
	} | null {
		const wantRead = this.clientCapabilities.fsReadTextFile;
		const wantBash = this.clientCapabilities.terminal;
		if (!wantRead && !wantBash) return null;

		const sessionIdRef = { current: "" };
		const customTools: ToolDefinition[] = [];

		if (wantRead) {
			const operations = createAcpReadOperations({
				conn: this.conn,
				getSessionId: () => sessionIdRef.current,
			});
			// Variance: `createReadToolDefinition` returns a narrowly-typed
			// ToolDefinition; `customTools[]` expects the wide form. Pi's
			// runtime treats every customTool through the unknown-args path,
			// so widening is safe. TS's exactOptionalPropertyTypes flags it
			// because `renderCall.args` is contravariant.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			const readToolDef = createReadToolDefinition(cwd, {
				operations,
			}) as unknown as ToolDefinition;
			customTools.push(readToolDef);
		}

		if (wantBash) {
			const operations = createAcpBashOperations({
				conn: this.conn,
				getSessionId: () => sessionIdRef.current,
			});
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
			const bashToolDef = createBashToolDefinition(cwd, {
				operations,
			}) as unknown as ToolDefinition;
			customTools.push(bashToolDef);
		}

		return {
			sessionIdRef,
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			customTools,
		};
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		const supportedVersion = 1;
		const requested = params.protocolVersion;

		this.clientCapabilities = parseClientCapabilities(params.clientCapabilities);

		return {
			protocolVersion: requested === supportedVersion ? requested : supportedVersion,
			agentInfo: {
				name: pkgJson.name,
				title: "pi ACP adapter",
				version: pkgJson.version,
			},
			authMethods: buildAuthMethods({
				supportsTerminalAuthMeta: this.clientCapabilities.terminalAuth,
			}),
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: { http: false, sse: false },
				promptCapabilities: {
					image: true,
					audio: false,
					embeddedContext: true,
				},
				sessionCapabilities: {
					list: {},
					close: {},
					resume: {},
					fork: {},
					delete: {},
				},
				providers: {},
			},
		};
	}

	async newSession(params: NewSessionRequest) {
		// In `local` / `overlay` modes the cwd must be absolute and exist on
		// disk. In `none` mode we synthesize a tmpdir and ignore params.cwd
		// for tool targeting, but the manifest still cascades from
		// params.cwd's project-root .pi-acp.yaml so a passed-in cwd is not
		// useless — we just don't run pi against it.
		const builtResources = await this.buildResourceLoader(params.cwd, params).catch(
			(e: unknown) => {
				const authErr = detectAuthError(e);
				if (authErr !== null) throw authErr;
				const msg = e instanceof Error ? e.message : String(e);
				throw RequestError.internalError({}, `Failed to load pi-acp manifest: ${msg}`);
			},
		);
		const {
			loader: resourceLoader,
			modeResult,
			diagnosticsEnabled,
			manifestDiagnostics,
		} = builtResources;
		const effectiveCwd = modeResult.cwd;

		if (modeResult.mode !== "none" && !isAbsolute(params.cwd)) {
			modeResult.cleanup();
			throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
		}

		const diagnosticsReport = diagnosticsEnabled
			? buildDiagnosticsReport({
					sources: resourceLoader.listSources(),
					manifestDiagnostics,
				}).text
			: "";

		const acpToolOverlay = this.buildAcpToolOverlay(effectiveCwd);
		let result: CreateAgentSessionResult;
		try {
			result = await createAgentSession({
				cwd: effectiveCwd,
				resourceLoader,
				...(acpToolOverlay
					? { tools: acpToolOverlay.tools, customTools: acpToolOverlay.customTools }
					: {}),
			});
		} catch (e: unknown) {
			modeResult.cleanup();
			const authErr = detectAuthError(e);
			if (authErr !== null) throw authErr;
			const msg = e instanceof Error ? e.message : String(e);
			throw RequestError.internalError({}, `Failed to create pi session: ${msg}`);
		}

		const piSession = result.session;
		if (acpToolOverlay !== null) {
			acpToolOverlay.sessionIdRef.current = piSession.sessionManager.getSessionId();
		}

		const availableModels = piSession.modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			piSession.dispose();
			modeResult.cleanup();
			throw RequestError.authRequired(
				{ authMethods: buildAuthMethods() },
				"Configure an API key or log in with an OAuth provider.",
			);
		}

		const sessionId = piSession.sessionManager.getSessionId();
		const sessionFile = piSession.sessionManager.getSessionFile();
		if (sessionFile !== undefined) {
			this.sessionPaths.set(sessionId, sessionFile);
		}

		const session = new PiAcpSession({
			sessionId,
			cwd: effectiveCwd,
			mcpServers: params.mcpServers,
			piSession,
			conn: this.conn,
			supportsTerminalOutput: this.clientCapabilities.terminalOutput,
			cleanups: modeResult.ephemeral ? [modeResult.cleanup] : [],
			...(diagnosticsReport !== "" ? { diagnosticsReport } : {}),
		});

		this.sessions.register(session);
		this.registerWithDaemon({ sessionId, piSession, cwd: params.cwd, sessionFile });

		const modes = buildThinkingModes(piSession);
		const models = buildModelState(piSession);
		const configOptions = buildConfigOptions(modes, models);

		const enableSkillCommands = skillCommandsEnabled(params.cwd);
		setTimeout(() => {
			void (async () => {
				try {
					const commands = buildCommandList(piSession, enableSkillCommands);
					await this.conn.sessionUpdate({
						sessionId: session.sessionId,
						update: {
							sessionUpdate: "available_commands_update",
							availableCommands: deduplicateCommands([...commands, ...BUILTIN_COMMANDS]),
						},
					});
				} catch {}
			})();
		}, 0);

		return {
			sessionId: session.sessionId,
			configOptions,
			modes,
			models,
		};
	}

	async authenticate(_params: AuthenticateRequest) {
		return {};
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		const { message, images } = acpPromptToPiMessage(params.prompt);

		if (images.length === 0 && message.trimStart().startsWith("/")) {
			const trimmed = message.trim();
			const space = trimmed.indexOf(" ");
			const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
			const argsString = space === -1 ? "" : trimmed.slice(space + 1);
			const args = parseArgs(argsString);

			const handled = await this.handleBuiltinCommand(session, cmd, args);
			if (handled) return handled;
		}

		const result = await session.prompt(message, images);

		const stopReason: StopReason = result === "error" ? "end_turn" : result;
		const usage = session.getUsage();
		const cost = session.getCost();

		return {
			stopReason,
			usage: {
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedReadTokens: usage.cachedReadTokens,
				cachedWriteTokens: usage.cachedWriteTokens,
				totalTokens: usage.inputTokens + usage.outputTokens,
			},
			_meta: cost > 0 ? { cost: { amount: cost, currency: "USD" } } : {},
		};
	}

	async cancel(params: CancelNotification): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		await session.cancel();
	}

	/**
	 * Resolve a session ID to a file path.
	 * Checks the local cache first (populated by listSessions/newSession),
	 * falls back to a full listAll() scan on cache miss.
	 */
	private async resolveSessionFile(sessionId: string): Promise<string | null> {
		const cached = this.sessionPaths.get(sessionId);
		if (cached !== undefined) return cached;

		const all = await PiSessionManager.listAll();
		for (const s of all) {
			this.sessionPaths.set(s.id, s.path);
		}

		return this.sessionPaths.get(sessionId) ?? null;
	}

	/**
	 * Replay persisted session messages as ACP session updates.
	 *
	 * Iterates through the message history, emitting structured updates for each
	 * content block type: text, thinking, tool calls, and tool results. A map of
	 * tool call IDs to their invocation data (from assistant messages) is built
	 * to enrich subsequent tool result updates with rawInput and locations.
	 */
	private async replaySessionHistory(
		session: PiAcpSession,
		messages: AgentMessage[],
	): Promise<void> {
		const toolCallMap = new Map<string, { name: string; args: ToolArgs }>();

		for (const m of messages) {
			if (!("role" in m)) continue;

			if (m.role === "user") {
				const text = extractUserMessageText((m satisfies UserMessage).content);
				if (text) {
					await this.conn.sessionUpdate({
						sessionId: session.sessionId,
						update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
					});
				}
				continue;
			}

			if (m.role === "assistant") {
				const am = m satisfies AssistantMessage;
				for (const block of am.content) {
					if (block.type === "text" && block.text) {
						await this.conn.sessionUpdate({
							sessionId: session.sessionId,
							update: {
								sessionUpdate: "agent_message_chunk",
								content: { type: "text", text: block.text },
							},
						});
					} else if (block.type === "thinking" && block.thinking) {
						await this.conn.sessionUpdate({
							sessionId: session.sessionId,
							update: {
								sessionUpdate: "agent_thought_chunk",
								content: { type: "text", text: block.thinking },
							},
						});
					} else if (block.type === "toolCall") {
						const args = toToolArgs(block.arguments);
						toolCallMap.set(block.id, { name: block.name, args });
						const locations = resolveToolPath(args, session.cwd);

						await this.conn.sessionUpdate({
							sessionId: session.sessionId,
							update: {
								sessionUpdate: "tool_call",
								toolCallId: block.id,
								title: buildToolTitle(block.name, args),
								kind: toToolKind(block.name),
								status: "completed",
								rawInput: args,
								...(locations ? { locations } : {}),
								_meta: { piAcp: { toolName: block.name } },
							},
						});
					}
				}
				continue;
			}

			if (m.role === "toolResult") {
				const tr = m satisfies ToolResultMessage;
				const toolName = tr.toolName;
				const toolCallId = tr.toolCallId;
				const isError = tr.isError;

				// Enrich from the preceding assistant tool call if available.
				const invocation = toolCallMap.get(toolCallId);
				const args = invocation?.args;
				const locations = args !== undefined ? resolveToolPath(args, session.cwd) : undefined;

				// If no tool_call was emitted from the assistant message (e.g. older
				// session format without structured assistant content), emit one now.
				if (invocation === undefined) {
					await this.conn.sessionUpdate({
						sessionId: session.sessionId,
						update: {
							sessionUpdate: "tool_call",
							toolCallId,
							title: buildToolTitle(toolName, {}),
							kind: toToolKind(toolName),
							status: "completed",
							rawInput: null,
							rawOutput: m,
							_meta: { piAcp: { toolName } },
						},
					});
				}

				const content = formatToolContent(toolName, m, isError);
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId,
						status: isError ? "failed" : "completed",
						content: content.length > 0 ? content : null,
						rawOutput: m,
						...(locations ? { locations } : {}),
						_meta: { piAcp: { toolName } },
					},
				});
			}
		}
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		const cwd = params.cwd;

		const raw =
			cwd !== undefined && cwd !== null
				? await PiSessionManager.list(cwd)
				: await PiSessionManager.listAll();

		for (const s of raw) {
			this.sessionPaths.set(s.id, s.path);
		}

		const sessions = raw.map((s) => ({
			id: s.id,
			cwd: s.cwd,
			name: s.name,
			firstMessage: s.firstMessage,
			modified: s.modified,
			messageCount: s.messageCount,
		}));

		if (params.cursor !== undefined && params.cursor !== null) {
			const parsed = Number.parseInt(params.cursor, 10);
			if (!Number.isFinite(parsed) || parsed < 0) {
				throw RequestError.invalidParams(`Invalid cursor: ${params.cursor}`);
			}
		}

		const start =
			params.cursor !== undefined && params.cursor !== null
				? Number.parseInt(params.cursor, 10)
				: 0;

		const PAGE_SIZE = 50;
		const page = sessions.slice(start, start + PAGE_SIZE);

		const liveSessions =
			this.daemonContext !== undefined ? this.daemonContext.sessionRegistry.listAll() : [];
		const liveById = new Map(liveSessions.map((e) => [e.sessionId, e]));

		const acpSessions: SessionInfo[] = page.map((s) => {
			const live = liveById.get(s.id);
			const isOwnedByThisConnection =
				live !== undefined &&
				(live.ownerConnectionId === this.connectionId || live.alsoHeldBy.has(this.connectionId));
			return {
				sessionId: s.id,
				cwd: s.cwd,
				title:
					(s.name !== undefined && s.name !== "" ? s.name : null) ??
					truncateSessionTitle(s.firstMessage) ??
					null,
				updatedAt: s.modified.toISOString(),
				...(live !== undefined
					? {
							_meta: {
								piAcp: {
									live: true,
									ownedByThisConnection: isOwnedByThisConnection,
								},
							},
						}
					: {}),
			};
		});

		// Surface daemon-live sessions that are NOT on disk yet (e.g., newSession
		// called but not yet persisted by pi). Insert at the front so the most
		// recently-active live ones bubble up.
		const seen = new Set(page.map((s) => s.id));
		const liveOnly = liveSessions
			.filter((e) => !seen.has(e.sessionId))
			.map<SessionInfo>((e) => ({
				sessionId: e.sessionId,
				cwd: e.cwd,
				title: null,
				updatedAt: e.updatedAt.toISOString(),
				_meta: {
					piAcp: {
						live: true,
						ownedByThisConnection:
							e.ownerConnectionId === this.connectionId || e.alsoHeldBy.has(this.connectionId),
					},
				},
			}));

		const merged = [...liveOnly, ...acpSessions];
		const nextCursor = start + PAGE_SIZE < sessions.length ? String(start + PAGE_SIZE) : null;

		return { sessions: merged, nextCursor, _meta: {} };
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		if (!isAbsolute(params.cwd)) {
			throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
		}

		this.sessions.close(params.sessionId);

		const sessionFile = await this.resolveSessionFile(params.sessionId);
		if (sessionFile === null) {
			throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
		}

		const acpToolOverlay = this.buildAcpToolOverlay(params.cwd);
		let result: CreateAgentSessionResult;
		try {
			const sm = PiSessionManager.open(sessionFile);
			const { loader: resourceLoader } = await this.buildResourceLoader(params.cwd, params, {
				resolveCwdMode: false,
			});
			result = await createAgentSession({
				cwd: params.cwd,
				sessionManager: sm,
				resourceLoader,
				...(acpToolOverlay
					? { tools: acpToolOverlay.tools, customTools: acpToolOverlay.customTools }
					: {}),
			});
		} catch (e: unknown) {
			const authErr = detectAuthError(e);
			if (authErr !== null) throw authErr;
			const msg = e instanceof Error ? e.message : String(e);
			throw RequestError.internalError({}, `Failed to load pi session: ${msg}`);
		}

		const piSession = result.session;
		if (acpToolOverlay !== null) {
			acpToolOverlay.sessionIdRef.current = piSession.sessionManager.getSessionId();
		}

		const session = new PiAcpSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			piSession,
			conn: this.conn,
			supportsTerminalOutput: this.clientCapabilities.terminalOutput,
		});

		this.sessions.register(session);
		this.registerWithDaemon({
			sessionId: params.sessionId,
			piSession,
			cwd: params.cwd,
			sessionFile,
		});

		await this.replaySessionHistory(session, piSession.messages);

		const modes = buildThinkingModes(piSession);
		const models = buildModelState(piSession);
		const configOptions = buildConfigOptions(modes, models);

		const enableSkillCommands = skillCommandsEnabled(params.cwd);
		setTimeout(() => {
			void (async () => {
				try {
					const commands = buildCommandList(piSession, enableSkillCommands);
					await this.conn.sessionUpdate({
						sessionId: session.sessionId,
						update: {
							sessionUpdate: "available_commands_update",
							availableCommands: deduplicateCommands([...commands, ...BUILTIN_COMMANDS]),
						},
					});
				} catch {}
			})();
		}, 0);

		return {
			configOptions,
			modes,
			models,
		};
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const local = this.sessions.maybeGet(params.sessionId);
		// Check daemon registry too: another client may have created the session
		// and this connection only resumed it; the local PiAcpSession wrapper
		// existed but the underlying piSession is shared.
		const inRegistry = this.daemonContext?.sessionRegistry.get(params.sessionId);
		if (local === undefined && inRegistry === undefined) {
			throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
		}

		// Release from registry first to decide whether to dispose pi runtime.
		const release = this.releaseFromDaemon(params.sessionId);
		if (release.disposed) {
			// Last holder — full close including pi dispose via SessionManager.
			this.sessions.close(params.sessionId);
		} else if (local !== undefined) {
			// Other clients still hold the session. Drop only this connection's
			// PiAcpSession wrapper (which holds our own event subscription).
			// SessionManager.detach removes the entry without disposing the
			// underlying piSession.
			this.sessions.detach(params.sessionId);
		}
		return {};
	}

	/**
	 * Deletes a session's on-disk file + releases any live state.
	 *
	 * Pi's SessionManager exposes no `delete()` method (verified against
	 * session-manager.d.ts) — sessions are append-only JSONL files. We
	 * unlink the file directly via `fs.rmSync`. `resolveSessionFile`
	 * sources paths from `PiSessionManager.listAll`, so the unlinked path
	 * is always inside `~/.pi/agent/sessions/...`.
	 *
	 * Refuses to delete sessions owned by ANOTHER connection in the daemon
	 * registry — security boundary: clients may only delete sessions they
	 * own or sessions that are not currently live. Always releases the
	 * daemon registry entry first so the live piSession is disposed
	 * cleanly before the file disappears.
	 *
	 * Gated by `sessionCapabilities.delete = {}` (advertised in initialize).
	 */
	async unstable_deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
		const sessionFile = await this.resolveSessionFile(params.sessionId);
		if (sessionFile === null) {
			throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
		}

		const live = this.daemonContext?.sessionRegistry.get(params.sessionId);
		if (live !== undefined && live.ownerConnectionId !== this.connectionId) {
			throw RequestError.invalidParams(
				`Session ${params.sessionId} is owned by another connection — cannot delete`,
			);
		}

		// Release from daemon registry (if we own it) so disposal cascade
		// runs cleanly before we unlink the file.
		if (live !== undefined) {
			const release = this.releaseFromDaemon(params.sessionId);
			if (release.disposed) this.sessions.close(params.sessionId);
		} else if (this.sessions.maybeGet(params.sessionId) !== undefined) {
			// Live in local manager only (no daemon).
			this.sessions.close(params.sessionId);
		}

		try {
			rmSync(sessionFile, { force: true });
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			throw RequestError.internalError({}, `Failed to delete session file: ${msg}`);
		}

		this.sessionPaths.delete(params.sessionId);
		return { _meta: { piAcp: { deletedFile: sessionFile } } };
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		if (!isAbsolute(params.cwd)) {
			throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
		}

		// If the session is already live in THIS connection, reuse it.
		const existing = this.sessions.maybeGet(params.sessionId);
		if (existing !== undefined) {
			const modes = buildThinkingModes(existing.piSession);
			const models = buildModelState(existing.piSession);
			return {
				configOptions: buildConfigOptions(modes, models),
				modes,
				models,
			};
		}

		// If another connection in the same daemon already holds the session,
		// attach to it and create a local PiAcpSession wrapping the shared
		// piSession with this connection's own event subscription + conn.
		if (this.daemonContext !== undefined) {
			const registry = this.daemonContext.sessionRegistry;
			const attached = registry.attach(params.sessionId, this.connectionId);
			if (attached !== undefined) {
				const session = new PiAcpSession({
					sessionId: params.sessionId,
					cwd: params.cwd,
					mcpServers: params.mcpServers ?? [],
					piSession: attached.piSession,
					conn: this.conn,
					supportsTerminalOutput: this.clientCapabilities.terminalOutput,
				});
				this.sessions.register(session);
				if (attached.sessionFile !== undefined) {
					this.sessionPaths.set(params.sessionId, attached.sessionFile);
				}
				const modes = buildThinkingModes(attached.piSession);
				const models = buildModelState(attached.piSession);
				return {
					configOptions: buildConfigOptions(modes, models),
					modes,
					models,
				};
			}
		}

		// Otherwise, load from disk (same path as loadSession but without replay).
		const sessionFile = await this.resolveSessionFile(params.sessionId);
		if (sessionFile === null) {
			throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
		}

		const acpToolOverlay = this.buildAcpToolOverlay(params.cwd);
		let result: CreateAgentSessionResult;
		try {
			const sm = PiSessionManager.open(sessionFile);
			const { loader: resourceLoader } = await this.buildResourceLoader(params.cwd, params, {
				resolveCwdMode: false,
			});
			result = await createAgentSession({
				cwd: params.cwd,
				sessionManager: sm,
				resourceLoader,
				...(acpToolOverlay
					? { tools: acpToolOverlay.tools, customTools: acpToolOverlay.customTools }
					: {}),
			});
		} catch (e: unknown) {
			const authErr = detectAuthError(e);
			if (authErr !== null) throw authErr;
			const msg = e instanceof Error ? e.message : String(e);
			throw RequestError.internalError({}, `Failed to resume pi session: ${msg}`);
		}

		const piSession = result.session;
		if (acpToolOverlay !== null) {
			acpToolOverlay.sessionIdRef.current = piSession.sessionManager.getSessionId();
		}

		const session = new PiAcpSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers ?? [],
			piSession,
			conn: this.conn,
			supportsTerminalOutput: this.clientCapabilities.terminalOutput,
		});

		this.sessions.register(session);
		this.sessionPaths.set(params.sessionId, sessionFile);
		this.registerWithDaemon({
			sessionId: params.sessionId,
			piSession,
			cwd: params.cwd,
			sessionFile,
		});

		const enableSkillCommands = skillCommandsEnabled(params.cwd);
		setTimeout(() => {
			void (async () => {
				try {
					const commands = buildCommandList(piSession, enableSkillCommands);
					await this.conn.sessionUpdate({
						sessionId: session.sessionId,
						update: {
							sessionUpdate: "available_commands_update",
							availableCommands: deduplicateCommands([...commands, ...BUILTIN_COMMANDS]),
						},
					});
				} catch {}
			})();
		}, 0);

		const modes = buildThinkingModes(piSession);
		const models = buildModelState(piSession);
		return {
			configOptions: buildConfigOptions(modes, models),
			modes,
			models,
		};
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		if (!isAbsolute(params.cwd)) {
			throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
		}

		const sourceFile = await this.resolveSessionFile(params.sessionId);
		if (sourceFile === null) {
			throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
		}

		const acpToolOverlay = this.buildAcpToolOverlay(params.cwd);
		let result: CreateAgentSessionResult;
		try {
			const sm = PiSessionManager.forkFrom(sourceFile, params.cwd);
			const { loader: resourceLoader } = await this.buildResourceLoader(params.cwd, params, {
				resolveCwdMode: false,
			});
			result = await createAgentSession({
				cwd: params.cwd,
				sessionManager: sm,
				resourceLoader,
				...(acpToolOverlay
					? { tools: acpToolOverlay.tools, customTools: acpToolOverlay.customTools }
					: {}),
			});
		} catch (e: unknown) {
			const authErr = detectAuthError(e);
			if (authErr !== null) throw authErr;
			const msg = e instanceof Error ? e.message : String(e);
			throw RequestError.internalError({}, `Failed to fork pi session: ${msg}`);
		}

		const piSession = result.session;

		const newSessionId = piSession.sessionManager.getSessionId();
		if (acpToolOverlay !== null) {
			acpToolOverlay.sessionIdRef.current = newSessionId;
		}
		const newSessionFile = piSession.sessionManager.getSessionFile();
		if (newSessionFile !== undefined) {
			this.sessionPaths.set(newSessionId, newSessionFile);
		}

		const session = new PiAcpSession({
			sessionId: newSessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers ?? [],
			piSession,
			conn: this.conn,
			supportsTerminalOutput: this.clientCapabilities.terminalOutput,
		});

		this.sessions.register(session);
		this.registerWithDaemon({
			sessionId: newSessionId,
			piSession,
			cwd: params.cwd,
			sessionFile: newSessionFile,
		});

		const enableSkillCommands = skillCommandsEnabled(params.cwd);
		setTimeout(() => {
			void (async () => {
				try {
					const commands = buildCommandList(piSession, enableSkillCommands);
					await this.conn.sessionUpdate({
						sessionId: session.sessionId,
						update: {
							sessionUpdate: "available_commands_update",
							availableCommands: deduplicateCommands([...commands, ...BUILTIN_COMMANDS]),
						},
					});
				} catch {}
			})();
		}, 0);

		const modes = buildThinkingModes(piSession);
		const models = buildModelState(piSession);
		return {
			sessionId: newSessionId,
			configOptions: buildConfigOptions(modes, models),
			modes,
			models,
		};
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		const session = this.sessions.get(params.sessionId);
		const mode = String(params.modeId);
		if (!isThinkingLevel(mode)) {
			throw RequestError.invalidParams(`Unknown modeId: ${mode}`);
		}

		session.piSession.setThinkingLevel(mode);

		void this.conn.sessionUpdate({
			sessionId: session.sessionId,
			update: { sessionUpdate: "current_mode_update", currentModeId: mode },
		});

		this.emitConfigOptionUpdate(session);

		return {};
	}

	async unstable_setSessionModel(
		params: SetSessionModelRequest,
	): Promise<SetSessionModelResponse | void> {
		const session = this.sessions.get(params.sessionId);
		const available = session.piSession.modelRegistry.getAvailable();

		const resolved = resolveModelPreference(available, params.modelId);
		if (resolved === null) {
			throw RequestError.invalidParams(`Unknown modelId: ${params.modelId}`);
		}

		const model = available.find((m) => m.provider === resolved.provider && m.id === resolved.id);
		if (!model) {
			throw RequestError.invalidParams(`Unknown modelId: ${params.modelId}`);
		}

		await session.piSession.setModel(model);
		this.emitConfigOptionUpdate(session);
	}

	async setSessionConfigOption(
		params: SetSessionConfigOptionRequest,
	): Promise<SetSessionConfigOptionResponse> {
		const session = this.sessions.get(params.sessionId);
		const configId = String(params.configId);
		const value = String(params.value);

		if (configId === "model") {
			const available = session.piSession.modelRegistry.getAvailable();
			const resolved = resolveModelPreference(available, value);
			if (resolved === null) {
				throw RequestError.invalidParams(`Unknown model: ${value}`);
			}

			const model = available.find((m) => m.provider === resolved.provider && m.id === resolved.id);
			if (!model) {
				throw RequestError.invalidParams(`Unknown model: ${value}`);
			}

			await session.piSession.setModel(model);
		} else if (configId === "thought_level") {
			if (!isThinkingLevel(value)) {
				throw RequestError.invalidParams(`Unknown thinking level: ${value}`);
			}
			session.piSession.setThinkingLevel(value);
		} else {
			throw RequestError.invalidParams(`Unknown config option: ${configId}`);
		}

		const modes = buildThinkingModes(session.piSession);
		const models = buildModelState(session.piSession);
		return { configOptions: buildConfigOptions(modes, models) };
	}

	private emitConfigOptionUpdate(session: PiAcpSession): void {
		const modes = buildThinkingModes(session.piSession);
		const models = buildModelState(session.piSession);
		const configOptions = buildConfigOptions(modes, models);

		void this.conn.sessionUpdate({
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions,
			},
		});
	}

	private async handleBuiltinCommand(
		session: PiAcpSession,
		cmd: string,
		args: string[],
	): Promise<PromptResponse | null> {
		const piSession = session.piSession;

		if (cmd === "compact") {
			const customInstructions = args.join(" ").trim() || undefined;
			const res = await piSession.compact(customInstructions);

			const headerLines = [
				`Compaction completed.${customInstructions !== undefined && customInstructions !== "" ? " (custom instructions applied)" : ""}`,
				typeof res?.tokensBefore === "number" ? `Tokens before: ${res.tokensBefore}` : null,
			].filter(Boolean);

			const text = headerLines.join("\n") + (res?.summary ? `\n\n${res.summary}` : "");

			await this.conn.sessionUpdate({
				sessionId: session.sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
			});
			return { stopReason: "end_turn" };
		}

		if (cmd === "session") {
			const stats = piSession.getSessionStats();
			const lines: string[] = [];
			if (stats.sessionId !== undefined && stats.sessionId !== "")
				lines.push(`Session: ${stats.sessionId}`);
			if (stats.sessionFile !== undefined && stats.sessionFile !== "")
				lines.push(`Session file: ${stats.sessionFile}`);
			lines.push(`Messages: ${stats.totalMessages}`);
			lines.push(`Cost: ${stats.cost}`);
			const t = stats.tokens;
			const parts: string[] = [];
			if (t.input) parts.push(`in ${t.input}`);
			if (t.output) parts.push(`out ${t.output}`);
			if (t.cacheRead) parts.push(`cache read ${t.cacheRead}`);
			if (t.cacheWrite) parts.push(`cache write ${t.cacheWrite}`);
			if (t.total) parts.push(`total ${t.total}`);
			if (parts.length > 0) lines.push(`Tokens: ${parts.join(", ")}`);

			const text = lines.join("\n");
			await this.conn.sessionUpdate({
				sessionId: session.sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
			});
			return { stopReason: "end_turn" };
		}

		if (cmd === "name") {
			const name = args.join(" ").trim();
			if (!name) {
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Usage: /name <name>" },
					},
				});
				return { stopReason: "end_turn" };
			}

			piSession.setSessionName(name);

			await this.conn.sessionUpdate({
				sessionId: session.sessionId,
				update: {
					sessionUpdate: "session_info_update",
					title: name,
					updatedAt: new Date().toISOString(),
				},
			});
			await this.conn.sessionUpdate({
				sessionId: session.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `Session name set: ${name}` },
				},
			});
			return { stopReason: "end_turn" };
		}

		if (cmd === "steering") {
			const modeRaw = String(args[0] ?? "").toLowerCase();
			if (!modeRaw) {
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `Steering mode: ${piSession.steeringMode}` },
					},
				});
				return { stopReason: "end_turn" };
			}
			if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Usage: /steering all | /steering one-at-a-time" },
					},
				});
				return { stopReason: "end_turn" };
			}
			piSession.setSteeringMode(modeRaw);
			await this.conn.sessionUpdate({
				sessionId: session.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `Steering mode set to: ${modeRaw}` },
				},
			});
			return { stopReason: "end_turn" };
		}

		if (cmd === "follow-up") {
			const modeRaw = String(args[0] ?? "").toLowerCase();
			if (!modeRaw) {
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `Follow-up mode: ${piSession.followUpMode}` },
					},
				});
				return { stopReason: "end_turn" };
			}
			if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Usage: /follow-up all | /follow-up one-at-a-time" },
					},
				});
				return { stopReason: "end_turn" };
			}
			piSession.setFollowUpMode(modeRaw);
			await this.conn.sessionUpdate({
				sessionId: session.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` },
				},
			});
			return { stopReason: "end_turn" };
		}

		if (cmd === "autocompact") {
			const mode = (args[0] ?? "toggle").toLowerCase();
			let enabled: boolean | null = null;
			if (mode === "on" || mode === "true" || mode === "enable") enabled = true;
			else if (mode === "off" || mode === "false" || mode === "disable") enabled = false;

			if (enabled === null) {
				enabled = !piSession.autoCompactionEnabled;
			}

			piSession.setAutoCompactionEnabled(enabled);

			await this.conn.sessionUpdate({
				sessionId: session.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.` },
				},
			});
			return { stopReason: "end_turn" };
		}

		if (cmd === "changelog") {
			const changelogPath = findChangelog();
			if (changelogPath === null) {
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Changelog not found." },
					},
				});
				return { stopReason: "end_turn" };
			}

			let text = "";
			try {
				text = readFileSync(changelogPath, "utf-8");
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `Failed to read changelog: ${msg}` },
					},
				});
				return { stopReason: "end_turn" };
			}

			const maxChars = 20_000;
			if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n...(truncated)...`;

			await this.conn.sessionUpdate({
				sessionId: session.sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
			});
			return { stopReason: "end_turn" };
		}

		if (cmd === "export") {
			const messageCount = piSession.messages.length;
			if (messageCount === 0) {
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Nothing to export yet. Send a prompt first." },
					},
				});
				return { stopReason: "end_turn" };
			}

			try {
				const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
				const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`);
				const resultPath = await piSession.exportToHtml(outputPath);

				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Session exported: " },
					},
				});
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "resource_link",
							name: `pi-session-${safeSessionId}.html`,
							uri: `file://${resultPath}`,
							mimeType: "text/html",
							title: "Session exported",
						},
					},
				});
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `Export failed: ${msg}` },
					},
				});
			}
			return { stopReason: "end_turn" };
		}

		return null;
	}
}

function isThinkingLevel(x: string): x is ThinkingLevel {
	return (
		x === "off" || x === "minimal" || x === "low" || x === "medium" || x === "high" || x === "xhigh"
	);
}

function buildThinkingModes(piSession: AgentSession): {
	availableModes: Array<{ id: string; name: string; description?: string | null }>;
	currentModeId: string;
} {
	const levels = piSession.getAvailableThinkingLevels();
	return {
		currentModeId: piSession.thinkingLevel,
		availableModes: levels.map((id) => ({
			id,
			name: `Thinking: ${id}`,
			description: null,
		})),
	};
}

function buildModelState(piSession: AgentSession): SessionModelState {
	const available = piSession.modelRegistry.getAvailable();
	const current = piSession.model;

	const availableModels: ModelInfo[] = available.map((m) => ({
		modelId: `${m.provider}/${m.id}`,
		name: `${m.provider}/${m.name ?? m.id}`,
		description: null,
	}));

	let currentModelId = "default";
	if (current !== undefined) {
		currentModelId = `${current.provider}/${current.id}`;
	} else if (availableModels.length > 0 && availableModels[0] !== undefined) {
		currentModelId = availableModels[0].modelId;
	}

	return { availableModels, currentModelId };
}

function buildConfigOptions(
	modes: SessionModeState,
	models: SessionModelState,
): SessionConfigOption[] {
	return [
		{
			id: "model",
			name: "Model",
			description: "AI model to use",
			category: "model",
			type: "select" as const,
			currentValue: models.currentModelId,
			options: models.availableModels.map((m) => ({
				value: m.modelId,
				name: m.name,
				description: m.description ?? null,
			})),
		},
		{
			id: "thought_level",
			name: "Thinking Level",
			description: "Reasoning depth for models that support it",
			category: "thought_level",
			type: "select" as const,
			currentValue: modes.currentModeId,
			options: modes.availableModes.map((m) => ({
				value: m.id,
				name: m.name,
				description: m.description ?? null,
			})),
		},
	];
}

function buildCommandList(
	piSession: AgentSession,
	enableSkillCommands: boolean,
): AvailableCommand[] {
	const commands: AvailableCommand[] = [];

	for (const template of piSession.promptTemplates) {
		commands.push({
			name: template.name,
			description: template.description ?? `(prompt)`,
		});
	}

	if (enableSkillCommands) {
		const skills = piSession.resourceLoader.getSkills();
		for (const skill of skills.skills) {
			commands.push({
				name: `skill:${skill.name}`,
				description: skill.description ?? `(skill)`,
			});
		}
	}

	for (const cmd of piSession.extensionRunner.getRegisteredCommands()) {
		commands.push({
			name: cmd.name,
			description: cmd.description ?? "(extension)",
		});
	}

	return commands;
}

function findChangelog(): string | null {
	try {
		const p = piChangelogPath();
		if (existsSync(p)) return p;
	} catch {}
	return null;
}
