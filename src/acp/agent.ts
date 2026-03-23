import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Agent as ACPAgent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AvailableCommand,
	type CancelNotification,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type ModelInfo,
	type NewSessionRequest,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type SessionConfigOption,
	type SessionInfo,
	type SessionModelState,
	type SessionModeState,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModelRequest,
	type SetSessionModelResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
	type StopReason,
} from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionResult,
	createAgentSession,
	VERSION as PI_VERSION,
	SessionManager as PiSessionManager,
} from "@mariozechner/pi-coding-agent";
import { buildAuthMethods } from "@pi-acp/acp/auth";
import { piAgentDir, quietStartupEnabled, skillCommandsEnabled } from "@pi-acp/acp/pi-settings";
import { PiAcpSession, SessionManager } from "@pi-acp/acp/session";
import { extractAssistantText, extractUserMessageText } from "@pi-acp/acp/translate/pi-messages";
import { toolResultToText } from "@pi-acp/acp/translate/pi-tools";
import { acpPromptToPiMessage } from "@pi-acp/acp/translate/prompt";
import { hasPiAuthConfigured } from "@pi-acp/pi-auth/status";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function builtinAvailableCommands(): AvailableCommand[] {
	return [
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
	];
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
	const out: AvailableCommand[] = [];
	const seen = new Set<string>();
	for (const c of [...a, ...b]) {
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

const pkg = readNearestPackageJson(import.meta.url);

export class PiAcpAgent implements ACPAgent {
	private readonly conn: AgentSideConnection;
	private readonly sessions = new SessionManager();

	dispose(): void {
		this.sessions.disposeAll();
	}

	constructor(conn: AgentSideConnection, _config?: unknown) {
		this.conn = conn;
		void _config;
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		const supportedVersion = 1;
		const requested = params.protocolVersion;

		return {
			protocolVersion: requested === supportedVersion ? requested : supportedVersion,
			agentInfo: {
				name: pkg.name,
				title: "pi ACP adapter",
				version: pkg.version,
			},
			authMethods: buildAuthMethods({
				supportsTerminalAuthMeta: params.clientCapabilities?._meta?.["terminal-auth"] === true,
			}),
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: { http: false, sse: false },
				promptCapabilities: {
					image: true,
					audio: false,
					embeddedContext: false,
				},
				sessionCapabilities: {
					list: {},
				},
			},
		};
	}

	async newSession(params: NewSessionRequest) {
		if (!isAbsolute(params.cwd)) {
			throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
		}

		if (!hasPiAuthConfigured()) {
			throw RequestError.authRequired(
				{ authMethods: buildAuthMethods() },
				"Configure an API key or log in with an OAuth provider.",
			);
		}

		let result: CreateAgentSessionResult;
		try {
			result = await createAgentSession({ cwd: params.cwd });
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			throw RequestError.internalError({}, `Failed to create pi session: ${msg}`);
		}

		const piSession = result.session;

		const availableModels = piSession.modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			piSession.dispose();
			throw RequestError.authRequired(
				{ authMethods: buildAuthMethods() },
				"Configure an API key or log in with an OAuth provider.",
			);
		}

		const sessionId = piSession.sessionManager.getSessionId();

		const session = new PiAcpSession({
			sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			piSession,
			conn: this.conn,
		});

		this.sessions.register(session);

		const quietStartup = quietStartupEnabled(params.cwd);
		const updateNotice = buildUpdateNotice();

		const preludeText = quietStartup
			? updateNotice !== null
				? `${updateNotice}\n`
				: ""
			: buildStartupInfo({ cwd: params.cwd, updateNotice });

		if (preludeText) session.setStartupInfo(preludeText);

		this.sessions.closeAllExcept(session.sessionId);

		const modes = buildThinkingModes(piSession);
		const models = buildModelState(piSession);
		const configOptions = buildConfigOptions(modes, models);

		const response = {
			sessionId: session.sessionId,
			configOptions,
			modes,
			models,
			_meta: {
				piAcp: { startupInfo: preludeText || null },
			},
		};

		if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0);

		const enableSkillCommands = skillCommandsEnabled(params.cwd);
		setTimeout(() => {
			void (async () => {
				try {
					const commands = buildCommandList(piSession, enableSkillCommands);
					await this.conn.sessionUpdate({
						sessionId: session.sessionId,
						update: {
							sessionUpdate: "available_commands_update",
							availableCommands: mergeCommands(commands, builtinAvailableCommands()),
						},
					});
				} catch {}
			})();
		}, 0);

		return response;
	}

	async authenticate(_params: AuthenticateRequest) {
		return;
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

		return { stopReason };
	}

	async cancel(params: CancelNotification): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		await session.cancel();
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		const cwd = params.cwd;

		const raw =
			cwd !== undefined && cwd !== null
				? await PiSessionManager.list(cwd)
				: await PiSessionManager.listAll();
		const sessions = raw.map((s) => ({
			id: s.id,
			cwd: s.cwd,
			name: s.name ?? "",
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

		const acpSessions: SessionInfo[] = page.map((s) => ({
			sessionId: s.id,
			cwd: s.cwd,
			title: s.name ?? null,
			updatedAt: s.modified.toISOString(),
		}));

		const nextCursor = start + PAGE_SIZE < sessions.length ? String(start + PAGE_SIZE) : null;

		return { sessions: acpSessions, nextCursor, _meta: {} };
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		if (!isAbsolute(params.cwd)) {
			throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
		}

		this.sessions.close(params.sessionId);

		const sessionFile = findPiSessionFile(params.sessionId);
		if (sessionFile === null) {
			throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
		}

		let result: CreateAgentSessionResult;
		try {
			const sm = PiSessionManager.open(sessionFile);
			result = await createAgentSession({
				cwd: params.cwd,
				sessionManager: sm,
			});
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			throw RequestError.internalError({}, `Failed to load pi session: ${msg}`);
		}

		const piSession = result.session;

		const session = new PiAcpSession({
			sessionId: params.sessionId,
			cwd: params.cwd,
			mcpServers: params.mcpServers,
			piSession,
			conn: this.conn,
		});

		this.sessions.register(session);
		this.sessions.closeAllExcept(session.sessionId);

		const messages: AgentMessage[] = piSession.messages;
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
			}

			if (m.role === "assistant") {
				const text = extractAssistantText((m satisfies AssistantMessage).content);
				if (text) {
					await this.conn.sessionUpdate({
						sessionId: session.sessionId,
						update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
					});
				}
			}

			if (m.role === "toolResult") {
				const tr = m satisfies ToolResultMessage;
				const toolName = tr.toolName;
				const toolCallId = tr.toolCallId;
				const isError = tr.isError;

				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId,
						title: toolName,
						kind:
							toolName === "read"
								? "read"
								: toolName === "write" || toolName === "edit"
									? "edit"
									: "other",
						status: "completed",
						rawInput: null,
						rawOutput: m,
					},
				});

				const text = toolResultToText(m);
				await this.conn.sessionUpdate({
					sessionId: session.sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId,
						status: isError ? "failed" : "completed",
						content: text ? [{ type: "content", content: { type: "text", text } }] : null,
						rawOutput: m,
					},
				});
			}
		}

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
							availableCommands: mergeCommands(commands, builtinAvailableCommands()),
						},
					});
				} catch {}
			})();
		}, 0);

		return {
			configOptions,
			modes,
			models,
			_meta: { piAcp: { startupInfo: null } },
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

		let provider: string | null = null;
		let modelId: string | null = null;

		if (params.modelId.includes("/")) {
			const [p, ...rest] = params.modelId.split("/");
			provider = p ?? null;
			modelId = rest.join("/");
		} else {
			modelId = params.modelId;
		}

		if (provider === null) {
			const available = session.piSession.modelRegistry.getAvailable();
			const found = available.find((m) => m.id === modelId);
			if (found) {
				provider = found.provider;
				modelId = found.id;
			}
		}

		if (provider === null || modelId === null) {
			throw RequestError.invalidParams(`Unknown modelId: ${params.modelId}`);
		}

		const available = session.piSession.modelRegistry.getAvailable();
		const model = available.find((m) => m.provider === provider && m.id === modelId);
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
			let provider: string | null = null;
			let modelId: string | null = null;

			if (value.includes("/")) {
				const [p, ...rest] = value.split("/");
				provider = p ?? null;
				modelId = rest.join("/");
			} else {
				modelId = value;
			}

			if (provider === null) {
				const available = session.piSession.modelRegistry.getAvailable();
				const found = available.find((m) => m.id === modelId);
				if (found) {
					provider = found.provider;
					modelId = found.id;
				}
			}

			if (provider === null || modelId === null) {
				throw RequestError.invalidParams(`Unknown model: ${value}`);
			}

			const available = session.piSession.modelRegistry.getAvailable();
			const model = available.find((m) => m.provider === provider && m.id === modelId);
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

	const runner = piSession.extensionRunner;
	if (runner) {
		for (const { command } of runner.getRegisteredCommandsWithPaths()) {
			commands.push({
				name: command.name,
				description: command.description ?? `(extension)`,
			});
		}
	}

	return commands;
}

function findPiSessionFile(sessionId: string): string | null {
	const sessionsDir = join(piAgentDir(), "sessions");
	if (!existsSync(sessionsDir)) return null;

	const walkJsonl = (dir: string): string | null => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return null;
		}

		for (const name of entries) {
			const p = join(dir, name);
			try {
				const st = statSync(p);
				if (st.isDirectory()) {
					const found = walkJsonl(p);
					if (found !== undefined) return found;
				} else if (st.isFile() && name.endsWith(".jsonl")) {
					try {
						const firstLine = readFileSync(p, "utf8").split("\n")[0];
						if (firstLine === undefined) continue;
						const header: unknown = JSON.parse(firstLine);
						if (
							typeof header === "object" &&
							header !== null &&
							"type" in header &&
							header.type === "session" &&
							"id" in header &&
							header.id === sessionId
						)
							return p;
					} catch {}
				}
			} catch {}
		}
		return null;
	};

	return walkJsonl(sessionsDir);
}

function buildUpdateNotice(): string | null {
	try {
		const installed = PI_VERSION;
		if (!installed || !isSemver(installed)) return null;

		const latestRes = spawnSync("npm", ["view", "@mariozechner/pi-coding-agent", "version"], {
			encoding: "utf-8",
			timeout: 800,
		});
		const latest = String(latestRes.stdout ?? "")
			.trim()
			.replace(/^v/i, "");
		if (!latest || !isSemver(latest)) return null;
		if (compareSemver(latest, installed) <= 0) return null;

		return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @mariozechner/pi-coding-agent\``;
	} catch {
		return null;
	}
}

function buildStartupInfo(opts: { cwd: string; updateNotice: string | null }): string {
	const md: string[] = [];

	if (PI_VERSION) {
		md.push(`pi v${PI_VERSION}`);
		md.push("---");
		md.push("");
	}

	const addSection = (title: string, items: string[]) => {
		const cleaned = items.map((s) => s.trim()).filter(Boolean);
		if (cleaned.length === 0) return;
		md.push(`## ${title}`);
		for (const item of cleaned) md.push(`- ${item}`);
		md.push("");
	};

	const contextItems: string[] = [];
	const contextPath = join(opts.cwd, "AGENTS.md");
	if (existsSync(contextPath)) contextItems.push(contextPath);
	addSection("Context", contextItems);

	if (opts.updateNotice !== undefined && opts.updateNotice !== null) {
		md.push("---");
		md.push(opts.updateNotice);
		md.push("");
	}

	return `${md.join("\n").trim()}\n`;
}

function findChangelog(): string | null {
	try {
		const whichCmd = process.platform === "win32" ? "where" : "which";
		const which = spawnSync(whichCmd, ["pi"], { encoding: "utf-8" });
		const piPath = String(which.stdout ?? "")
			.split(/\r?\n/)[0]
			?.trim();
		if (piPath !== undefined && piPath !== "") {
			const resolved = realpathSync(piPath);
			const pkgRoot = dirname(dirname(resolved));
			const p = join(pkgRoot, "CHANGELOG.md");
			if (existsSync(p)) return p;
		}
	} catch {}

	try {
		const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
		const root = String(npmRoot.stdout ?? "").trim();
		if (root) {
			const p = join(root, "@mariozechner", "pi-coding-agent", "CHANGELOG.md");
			if (existsSync(p)) return p;
		}
	} catch {}

	return null;
}

function isSemver(v: string): boolean {
	return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}

function compareSemver(a: string, b: string): number {
	const pa = a
		.split(/[.-]/)
		.slice(0, 3)
		.map((n) => Number(n));
	const pb = b
		.split(/[.-]/)
		.slice(0, 3)
		.map((n) => Number(n));
	for (let i = 0; i < 3; i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da > db) return 1;
		if (da < db) return -1;
	}
	return 0;
}

function readNearestPackageJson(metaUrl: string): { name: string; version: string } {
	const fallback = { name: "pi-acp", version: "0.0.0" };
	try {
		let dir = dirname(fileURLToPath(metaUrl));
		for (let i = 0; i < 6; i++) {
			const p = join(dir, "package.json");
			if (existsSync(p)) {
				const raw: unknown = JSON.parse(readFileSync(p, "utf-8"));
				if (typeof raw !== "object" || raw === null) return fallback;
				const name = "name" in raw && typeof raw.name === "string" ? raw.name : fallback.name;
				const version =
					"version" in raw && typeof raw.version === "string" ? raw.version : fallback.version;
				return { name, version };
			}
			dir = dirname(dir);
		}
	} catch {
		// fall through
	}
	return fallback;
}
