import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
	type AgentSideConnection,
	type ContentBlock,
	type McpServer,
	RequestError,
	type SessionUpdate,
	type ToolCallContent,
	type ToolCallLocation,
	type ToolKind,
} from "@agentclientprotocol/sdk";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEvent, ToolCall } from "@mariozechner/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { formatToolContent, wrapStreamingBashOutput } from "@pi-acp/acp/translate/tool-content";
import * as z from "zod";

export type StopReason = "end_turn" | "cancelled" | "max_tokens" | "error";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findUniqueLineNumber(text: string, needle: string): number | undefined {
	if (!needle) return undefined;
	const first = text.indexOf(needle);
	if (first < 0) return undefined;
	if (text.indexOf(needle, first + needle.length) >= 0) return undefined;

	let line = 1;
	for (let i = 0; i < first; i++) {
		if (text.charCodeAt(i) === 10) line++;
	}
	return line;
}

export interface ToolArgs {
	path?: string | undefined;
	oldText?: string | undefined;
	[key: string]: unknown;
}

export function resolveToolPath(
	args: ToolArgs,
	cwd: string,
	line?: number,
): ToolCallLocation[] | undefined {
	const p = args.path;
	if (p === undefined) return undefined;

	const resolved = isAbsolute(p) ? p : resolvePath(cwd, p);
	return [{ path: resolved, ...(typeof line === "number" ? { line } : {}) }];
}

export function toToolKind(toolName: string): ToolKind {
	switch (toolName) {
		case "read":
			return "read";
		case "write":
		case "edit":
			return "edit";
		case "bash":
		case "tmux":
			return "execute";
		case "lsp":
			return "search";
		default:
			return "other";
	}
}

const MAX_TITLE_LEN = 80;

function truncateTitle(text: string): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	if (oneLine.length <= MAX_TITLE_LEN) return oneLine;
	return `${oneLine.slice(0, MAX_TITLE_LEN - 1)}…`;
}

function capitalize(s: string): string {
	if (s.length === 0) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build a descriptive tool title from tool name and args.
 *
 * Returns a short human-readable label like "Read src/index.ts" or "Run ls -la".
 */
export function buildToolTitle(toolName: string, args: ToolArgs): string {
	const p = args.path;

	switch (toolName) {
		case "read":
			return p !== undefined ? `Read ${p}` : "Read";
		case "write":
			return p !== undefined ? `Write ${p}` : "Write";
		case "edit":
			return p !== undefined ? `Edit ${p}` : "Edit";
		case "bash": {
			const command =
				typeof args["command"] === "string"
					? args["command"]
					: typeof args["cmd"] === "string"
						? args["cmd"]
						: undefined;
			return command !== undefined ? truncateTitle(`Run ${command}`) : "bash";
		}
		case "lsp": {
			const action = typeof args["action"] === "string" ? args["action"] : undefined;
			const file = typeof args["file"] === "string" ? args["file"] : undefined;
			const query = typeof args["query"] === "string" ? args["query"] : undefined;
			const line = typeof args["line"] === "number" ? args["line"] : undefined;
			if (action !== undefined) {
				const target = file !== undefined ? (line !== undefined ? `${file}:${line}` : file) : query;
				return target !== undefined
					? truncateTitle(`${capitalize(action)} ${target}`)
					: capitalize(action);
			}
			return "LSP";
		}
		case "tmux": {
			const action = typeof args["action"] === "string" ? args["action"] : undefined;
			const command = typeof args["command"] === "string" ? args["command"] : undefined;
			const name = typeof args["name"] === "string" ? args["name"] : undefined;
			if (action === "run" && command !== undefined) return truncateTitle(`Tmux: ${command}`);
			if (action !== undefined && name !== undefined)
				return truncateTitle(`Tmux ${action} ${name}`);
			if (action !== undefined) return `Tmux ${action}`;
			return "Tmux";
		}
		case "context_tag": {
			const name = typeof args["name"] === "string" ? args["name"] : undefined;
			return name !== undefined ? `Tag ${name}` : "Tag";
		}
		case "context_log":
			return "Context log";
		case "context_checkout": {
			const target = typeof args["target"] === "string" ? args["target"] : undefined;
			return target !== undefined ? truncateTitle(`Checkout ${target}`) : "Checkout";
		}
		case "claudemon":
			return "Check quota";
		default:
			return toolName;
	}
}

/**
 * Map pi assistant stopReason to ACP StopReason.
 * pi: "stop" | "length" | "toolUse" | "error" | "aborted"
 * ACP: "end_turn" | "cancelled" | "max_tokens" | "error"
 */
function mapPiStopReason(piReason: string | null): StopReason {
	switch (piReason) {
		case "stop":
		case "toolUse":
			return "end_turn";
		case "length":
			return "max_tokens";
		case "aborted":
			return "cancelled";
		case "error":
			return "error";
		default:
			return "end_turn";
	}
}

function extractToolCallFromPartial(ame: AssistantMessageEvent): ToolCall | undefined {
	if (!("partial" in ame)) return undefined;
	const content = ame.partial.content;
	const idx = "contentIndex" in ame ? ame.contentIndex : 0;
	const block = content[idx];
	if (block && "type" in block && block.type === "toolCall") return block;
	return undefined;
}

function parseToolInput(tc: ToolCall): ToolArgs {
	return tc.arguments;
}

const toolArgsSchema = z
	.object({
		path: z.string().trim().optional(),
		oldText: z.string().trim().optional(),
	})
	.loose();

export function toToolArgs(raw: unknown): ToolArgs {
	const result = toolArgsSchema.safeParse(raw);
	return result.success ? result.data : {};
}

// ---------------------------------------------------------------------------
// _meta builder helpers
// ---------------------------------------------------------------------------

type PiAcpMeta = Record<string, unknown>;

/** Build the `_meta.piAcp` tool name metadata. */
function buildToolMeta(toolName: string, extra?: PiAcpMeta): PiAcpMeta {
	const base: PiAcpMeta = { piAcp: { toolName } };
	if (extra !== undefined) {
		return { ...base, ...extra };
	}
	return base;
}

// ---------------------------------------------------------------------------
// Terminal tool classification
// ---------------------------------------------------------------------------

/** Tools that produce terminal-style output. */
function isTerminalTool(toolName: string): boolean {
	return toolName === "bash" || toolName === "tmux";
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

export class SessionManager {
	private sessions = new Map<string, PiAcpSession>();

	disposeAll(): void {
		for (const id of this.sessions.keys()) this.close(id);
	}

	maybeGet(sessionId: string): PiAcpSession | undefined {
		return this.sessions.get(sessionId);
	}

	close(sessionId: string): void {
		const s = this.sessions.get(sessionId);
		if (!s) return;
		try {
			s.dispose();
		} catch {
			// best-effort
		}
		this.sessions.delete(sessionId);
	}

	closeAllExcept(keepSessionId: string): void {
		for (const id of this.sessions.keys()) {
			if (id !== keepSessionId) this.close(id);
		}
	}

	register(session: PiAcpSession): void {
		this.sessions.set(session.sessionId, session);
	}

	get(sessionId: string): PiAcpSession {
		const s = this.sessions.get(sessionId);
		if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`);
		return s;
	}
}

// ---------------------------------------------------------------------------
// ACP session wrapping a pi AgentSession
// ---------------------------------------------------------------------------

export interface PiAcpSessionOpts {
	sessionId: string;
	cwd: string;
	mcpServers: McpServer[];
	piSession: AgentSession;
	conn: AgentSideConnection;
	/** Whether the client supports terminal output metadata. */
	supportsTerminalOutput?: boolean | undefined;
}

export class PiAcpSession {
	readonly sessionId: string;
	readonly cwd: string;
	readonly mcpServers: McpServer[];
	readonly piSession: AgentSession;
	readonly supportsTerminalOutput: boolean;

	private startupInfo: string | null = null;
	private startupInfoSent = false;
	private readonly conn: AgentSideConnection;

	private cancelRequested = false;
	private pendingTurn: { resolve: (r: StopReason) => void; reject: (e: unknown) => void } | null =
		null;

	private currentToolCalls = new Map<string, "pending" | "in_progress">();
	/** Map of toolCallId -> toolName for streaming updates (Phase 5). */
	private toolCallNames = new Map<string, string>();
	private editSnapshots = new Map<string, { path: string; oldText: string }>();
	private lastAssistantStopReason: string | null = null;
	private lastEmit: Promise<void> = Promise.resolve();
	private unsubscribe: (() => void) | undefined;

	constructor(opts: PiAcpSessionOpts) {
		this.sessionId = opts.sessionId;
		this.cwd = opts.cwd;
		this.mcpServers = opts.mcpServers;
		this.piSession = opts.piSession;
		this.conn = opts.conn;
		this.supportsTerminalOutput = opts.supportsTerminalOutput ?? false;
		this.unsubscribe = this.piSession.subscribe((ev: AgentSessionEvent) => this.handlePiEvent(ev));
	}

	dispose(): void {
		this.unsubscribe?.();
		this.piSession.dispose();
	}

	setStartupInfo(text: string): void {
		this.startupInfo = text;
	}

	sendStartupInfoIfPending(): void {
		if (this.startupInfoSent || this.startupInfo === null) return;
		this.startupInfoSent = true;
		this.emit({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: this.startupInfo },
		});
	}

	async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
		const turnPromise = new Promise<StopReason>((resolve, reject) => {
			this.cancelRequested = false;
			this.pendingTurn = { resolve, reject };
		});

		const imageContents = Array.isArray(images)
			? images.filter(
					(img): img is { type: "image"; data: string; mimeType: string } =>
						typeof img === "object" && img !== null && "type" in img && img.type === "image",
				)
			: [];

		this.piSession.prompt(message, { images: imageContents }).catch(() => {
			void this.flushEmits().finally(() => {
				const reason: StopReason = this.cancelRequested ? "cancelled" : "error";
				this.pendingTurn?.resolve(reason);
				this.pendingTurn = null;
			});
		});

		return turnPromise;
	}

	async cancel(): Promise<void> {
		this.cancelRequested = true;
		await this.piSession.abort();
	}

	wasCancelRequested(): boolean {
		return this.cancelRequested;
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private emit(update: SessionUpdate): void {
		this.lastEmit = this.lastEmit
			.then(() => this.conn.sessionUpdate({ sessionId: this.sessionId, update }))
			.catch(() => {});
	}

	private async flushEmits(): Promise<void> {
		await this.lastEmit;
	}

	private handlePiEvent(ev: AgentSessionEvent): void {
		if (!isAgentEvent(ev)) return;

		switch (ev.type) {
			case "message_update":
				this.handleMessageUpdate(ev.assistantMessageEvent);
				break;
			case "message_end":
				this.handleMessageEnd(ev.message);
				break;
			case "tool_execution_start":
				this.handleToolStart(ev.toolCallId, ev.toolName, toToolArgs(ev.args));
				break;
			case "tool_execution_update":
				this.handleToolUpdate(ev.toolCallId, ev.toolName, ev.partialResult);
				break;
			case "tool_execution_end":
				this.handleToolEnd(ev.toolCallId, ev.toolName, ev.result, ev.isError);
				break;
			case "agent_end":
				this.handleAgentEnd();
				break;
			default:
				break;
		}
	}

	private handleMessageUpdate(ame: AssistantMessageEvent): void {
		if (ame.type === "text_delta") {
			this.emit({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: ame.delta } satisfies ContentBlock,
			});
			return;
		}

		if (ame.type === "thinking_delta") {
			this.emit({
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: ame.delta } satisfies ContentBlock,
			});
			return;
		}

		if (
			ame.type === "toolcall_start" ||
			ame.type === "toolcall_delta" ||
			ame.type === "toolcall_end"
		) {
			const toolCall = ame.type === "toolcall_end" ? ame.toolCall : extractToolCallFromPartial(ame);
			if (!toolCall) return;

			const rawInput = parseToolInput(toolCall);
			const locations = resolveToolPath(rawInput, this.cwd);
			const existingStatus = this.currentToolCalls.get(toolCall.id);
			const status = existingStatus ?? "pending";

			if (!existingStatus) {
				this.currentToolCalls.set(toolCall.id, "pending");
				this.emit({
					sessionUpdate: "tool_call",
					toolCallId: toolCall.id,
					title: buildToolTitle(toolCall.name, rawInput),
					kind: toToolKind(toolCall.name),
					status,
					...(locations ? { locations } : {}),
					rawInput,
					_meta: buildToolMeta(toolCall.name),
				});
			} else {
				this.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: toolCall.id,
					status,
					...(locations ? { locations } : {}),
					rawInput,
					_meta: buildToolMeta(toolCall.name),
				});
			}
		}
	}

	private handleMessageEnd(msg: AgentMessage): void {
		if ("role" in msg && msg.role === "assistant") {
			this.lastAssistantStopReason = msg.stopReason;
		}
	}

	private handleToolStart(toolCallId: string, toolName: string, args: ToolArgs): void {
		// Track toolName for streaming updates (Phase 5)
		this.toolCallNames.set(toolCallId, toolName);

		let line: number | undefined;

		if ((toolName === "edit" || toolName === "write") && args.path !== undefined) {
			try {
				const abs = isAbsolute(args.path) ? args.path : resolvePath(this.cwd, args.path);
				let oldText = "";
				try {
					oldText = readFileSync(abs, "utf8");
				} catch {
					// File may not exist yet for write -- treat as empty.
				}
				this.editSnapshots.set(toolCallId, { path: abs, oldText });
				if (toolName === "edit") {
					line = findUniqueLineNumber(oldText, args.oldText ?? "");
				}
			} catch {
				// snapshot failure is non-fatal
			}
		}

		const locations = resolveToolPath(args, this.cwd, line);

		// Build terminal metadata for bash/tmux when client supports it
		const terminalMeta =
			this.supportsTerminalOutput && isTerminalTool(toolName)
				? { terminal_info: { terminal_id: toolCallId, cwd: this.cwd } }
				: undefined;
		const meta = buildToolMeta(toolName, terminalMeta);

		// Build content for terminal-aware clients
		const terminalContent: ToolCallContent[] | undefined =
			this.supportsTerminalOutput && isTerminalTool(toolName)
				? [{ type: "terminal" as const, terminalId: toolCallId }]
				: undefined;

		if (!this.currentToolCalls.has(toolCallId)) {
			this.currentToolCalls.set(toolCallId, "in_progress");
			this.emit({
				sessionUpdate: "tool_call",
				toolCallId,
				title: buildToolTitle(toolName, args),
				kind: toToolKind(toolName),
				status: "in_progress",
				...(locations ? { locations } : {}),
				...(terminalContent !== undefined ? { content: terminalContent } : {}),
				rawInput: args,
				_meta: meta,
			});
		} else {
			this.currentToolCalls.set(toolCallId, "in_progress");
			this.emit({
				sessionUpdate: "tool_call_update",
				toolCallId,
				title: buildToolTitle(toolName, args),
				status: "in_progress",
				...(locations ? { locations } : {}),
				...(terminalContent !== undefined ? { content: terminalContent } : {}),
				rawInput: args,
				_meta: meta,
			});
		}
	}

	private handleToolUpdate(toolCallId: string, toolName: string, partialResult: unknown): void {
		// Look up tool name from our map (Phase 5), fall back to event's toolName
		const name = this.toolCallNames.get(toolCallId) ?? toolName;

		if (this.supportsTerminalOutput && isTerminalTool(name)) {
			// Terminal-aware path: emit only _meta.terminal_output, no content
			const text = extractStreamingText(partialResult);
			this.emit({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "in_progress",
				_meta: buildToolMeta(name, {
					terminal_output: { terminal_id: toolCallId, data: text },
				}),
				rawOutput: partialResult,
			});
		} else if (isTerminalTool(name)) {
			// Non-terminal fallback: wrap in console code fence
			const text = extractStreamingText(partialResult);
			const wrapped = wrapStreamingBashOutput(text);
			this.emit({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "in_progress",
				content: wrapped
					? ([
							{ type: "content", content: { type: "text", text: wrapped } },
						] satisfies ToolCallContent[])
					: null,
				_meta: buildToolMeta(name),
				rawOutput: partialResult,
			});
		} else {
			// Other tools: plain text content
			const text = extractStreamingText(partialResult);
			this.emit({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "in_progress",
				content: text
					? ([{ type: "content", content: { type: "text", text } }] satisfies ToolCallContent[])
					: null,
				_meta: buildToolMeta(name),
				rawOutput: partialResult,
			});
		}
	}

	private handleToolEnd(
		toolCallId: string,
		toolName: string,
		result: unknown,
		isError: boolean,
	): void {
		const snapshot = this.editSnapshots.get(toolCallId);
		let content: ToolCallContent[] | null = null;

		// Diff path for edit/write
		if (!isError && snapshot) {
			try {
				const newText = readFileSync(snapshot.path, "utf8");
				if (newText !== snapshot.oldText) {
					const formatted = formatToolContent(toolName, result, isError);
					content = [
						{ type: "diff", path: snapshot.path, oldText: snapshot.oldText, newText },
						...formatted,
					];
				}
			} catch {
				// fall back to formatted content
			}
		}

		// Terminal exit metadata for bash/tmux
		const terminalExitMeta =
			this.supportsTerminalOutput && isTerminalTool(toolName)
				? {
						terminal_exit: {
							terminal_id: toolCallId,
							exit_code: extractExitCode(result),
							signal: null,
						},
					}
				: undefined;
		const meta = buildToolMeta(toolName, terminalExitMeta);

		// If no diff content, use formatted tool content
		if (content === null) {
			const formatted = formatToolContent(toolName, result, isError);
			content = formatted.length > 0 ? formatted : null;
		}

		// Last resort: if formatToolContent returns empty and no diff, generate plain text
		if (content === null && !isError && toolName !== "edit" && toolName !== "write") {
			const text = extractStreamingText(result);
			if (text) {
				content = [{ type: "content", content: { type: "text", text } }];
			}
		}

		this.emit({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: isError ? "failed" : "completed",
			content,
			_meta: meta,
			rawOutput: result,
		});

		this.currentToolCalls.delete(toolCallId);
		this.editSnapshots.delete(toolCallId);
		this.toolCallNames.delete(toolCallId);
	}

	private handleAgentEnd(): void {
		this.emitUsageUpdate();
		void this.flushEmits().finally(() => {
			const reason: StopReason = this.cancelRequested
				? "cancelled"
				: mapPiStopReason(this.lastAssistantStopReason);
			this.lastAssistantStopReason = null;
			this.pendingTurn?.resolve(reason);
			this.pendingTurn = null;
		});
	}

	/**
	 * Emit a usage_update notification with current context and cost data.
	 */
	private emitUsageUpdate(): void {
		const contextUsage = this.piSession.getContextUsage?.();
		const stats = this.piSession.getSessionStats();

		const used = contextUsage?.tokens ?? 0;
		const size = contextUsage?.contextWindow ?? 0;

		this.emit({
			sessionUpdate: "usage_update",
			used,
			size,
			cost: stats.cost > 0 ? { amount: stats.cost, currency: "USD" } : null,
		});
	}

	/**
	 * Build ACP Usage data from pi session stats for prompt response.
	 */
	getUsage(): {
		inputTokens: number;
		outputTokens: number;
		cachedReadTokens: number;
		cachedWriteTokens: number;
	} {
		const stats = this.piSession.getSessionStats();
		return {
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			cachedReadTokens: stats.tokens.cacheRead,
			cachedWriteTokens: stats.tokens.cacheWrite,
		};
	}

	/**
	 * Get cumulative session cost.
	 */
	getCost(): number {
		return this.piSession.getSessionStats().cost;
	}
}

// ---------------------------------------------------------------------------
// Streaming text extraction (lightweight, no formatting)
// ---------------------------------------------------------------------------

function isTextBlock(v: unknown): v is { type: "text"; text: string } {
	return (
		typeof v === "object" &&
		v !== null &&
		"type" in v &&
		v.type === "text" &&
		"text" in v &&
		typeof v.text === "string"
	);
}

function extractStreamingText(result: unknown): string {
	if (result === null || result === undefined) return "";
	if (typeof result === "string") return result;
	if (typeof result !== "object") return String(result);

	// Content blocks
	if ("content" in result && Array.isArray(result.content)) {
		const texts: string[] = [];
		for (const raw of result.content) {
			if (isTextBlock(raw)) {
				texts.push(raw.text);
			}
		}
		if (texts.length > 0) return texts.join("");
	}

	// Details fields
	if ("details" in result) {
		const details = result.details;
		if (typeof details === "object" && details !== null) {
			if ("stdout" in details && typeof details.stdout === "string" && details.stdout.trim() !== "")
				return details.stdout;
			if ("output" in details && typeof details.output === "string" && details.output.trim() !== "")
				return details.output;
		}
	}

	// Top-level output/stdout
	if ("output" in result && typeof result.output === "string" && result.output.trim() !== "")
		return result.output;
	if ("stdout" in result && typeof result.stdout === "string" && result.stdout.trim() !== "")
		return result.stdout;

	return "";
}

function extractExitCode(result: unknown): number | null {
	if (result === null || result === undefined || typeof result !== "object") return null;

	if ("details" in result) {
		const details = result.details;
		if (typeof details === "object" && details !== null) {
			if ("exitCode" in details && typeof details.exitCode === "number") return details.exitCode;
			if ("code" in details && typeof details.code === "number") return details.code;
		}
	}

	if ("exitCode" in result && typeof result.exitCode === "number") return result.exitCode;
	if ("code" in result && typeof result.code === "number") return result.code;

	return null;
}

/**
 * Type guard to narrow AgentSessionEvent to the AgentEvent subset
 * (the variants we handle). Session-specific events like auto_compaction
 * are ignored.
 */
function isAgentEvent(
	ev: AgentSessionEvent,
): ev is Extract<
	AgentEvent,
	| { type: "message_update" }
	| { type: "message_end" }
	| { type: "tool_execution_start" }
	| { type: "tool_execution_update" }
	| { type: "tool_execution_end" }
	| { type: "agent_end" }
> {
	return (
		ev.type === "message_update" ||
		ev.type === "message_end" ||
		ev.type === "tool_execution_start" ||
		ev.type === "tool_execution_update" ||
		ev.type === "tool_execution_end" ||
		ev.type === "agent_end"
	);
}
