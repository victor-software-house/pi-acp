import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

type SessionUpdateMsg = Parameters<AgentSideConnection["sessionUpdate"]>[0];

export class FakeAgentSideConnection {
	readonly updates: SessionUpdateMsg[] = [];

	async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
		this.updates.push(msg);
	}
}

export class FakeAgentSession {
	private handlers: ((ev: AgentSessionEvent) => void)[] = [];

	readonly prompts: { message: string; images?: unknown[] }[] = [];
	abortCount = 0;
	_thinkingLevel = "medium";
	_steeringMode: "all" | "one-at-a-time" = "one-at-a-time";
	_followUpMode: "all" | "one-at-a-time" = "one-at-a-time";
	_autoCompactionEnabled = true;
	_sessionName: string | undefined = undefined;
	_messages: unknown[] = [];

	subscribe(handler: (ev: AgentSessionEvent) => void): () => void {
		this.handlers.push(handler);
		return () => {
			this.handlers = this.handlers.filter((h) => h !== handler);
		};
	}

	emit(ev: AgentSessionEvent) {
		for (const h of this.handlers) h(ev);
	}

	async prompt(message: string, opts?: { images?: unknown[] }): Promise<void> {
		this.prompts.push({ message, images: opts?.images ?? [] });
	}

	async abort(): Promise<void> {
		this.abortCount += 1;
	}

	dispose(): void {}

	get thinkingLevel() {
		return this._thinkingLevel;
	}
	get steeringMode() {
		return this._steeringMode;
	}
	get followUpMode() {
		return this._followUpMode;
	}
	get autoCompactionEnabled() {
		return this._autoCompactionEnabled;
	}
	get sessionName() {
		return this._sessionName;
	}
	get messages() {
		return this._messages;
	}

	setThinkingLevel(level: string) {
		this._thinkingLevel = level;
	}
	setSteeringMode(mode: "all" | "one-at-a-time") {
		this._steeringMode = mode;
	}
	setFollowUpMode(mode: "all" | "one-at-a-time") {
		this._followUpMode = mode;
	}
	setAutoCompactionEnabled(enabled: boolean) {
		this._autoCompactionEnabled = enabled;
	}
	setSessionName(name: string) {
		this._sessionName = name;
	}

	getAvailableThinkingLevels() {
		return ["off", "minimal", "low", "medium", "high", "xhigh"];
	}

	get model() {
		return { provider: "test", id: "model", name: "model" };
	}

	get modelRegistry() {
		return {
			getAvailable: () => [{ provider: "test", id: "model", name: "model" }],
		};
	}

	get sessionManager() {
		return { getSessionId: () => "test-session-id" };
	}

	get resourceLoader() {
		return { getSkills: () => ({ skills: [], diagnostics: [] }) };
	}

	get extensionRunner() {
		return undefined;
	}

	get promptTemplates() {
		return [];
	}

	getSessionStats() {
		return {
			sessionFile: undefined,
			sessionId: "test",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		};
	}

	async compact(_customInstructions?: string) {
		return { summary: "compacted", tokensBefore: 100, firstKeptEntryId: "" };
	}

	async exportToHtml(outputPath: string) {
		return outputPath;
	}
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
	return conn as unknown as AgentSideConnection;
}
