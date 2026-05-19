import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * pi-acp wraps pi's `SessionManager` directly — every session it creates,
 * lists, opens, or forks goes through the same class the pi CLI uses. This
 * test pins that compatibility contract:
 *
 *   - sessions are stored as line-delimited JSON
 *   - the header carries `version: CURRENT_SESSION_VERSION` (currently 3)
 *   - entries written through SessionManager are readable back through
 *     SessionManager.open(...) without any pi-acp-specific decoding
 *
 * If pi changes the on-disk shape, this test fails and signals that the
 * pi CLI ↔ pi-acp interop story needs review.
 */

function minimalAssistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-x",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function minimalUser(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
}

describe("session storage round-trips through pi's SessionManager", () => {
	test("writes NDJSON with header + entries that re-open cleanly", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-acp-session-compat-"));
		try {
			const sm = SessionManager.create(dir, dir);
			const id1 = sm.appendMessage(minimalUser("hello pi"));
			// pi only flushes to disk once an assistant turn arrives.
			const id2 = sm.appendMessage(minimalAssistant("hi from pi"));
			sm.appendMessage(minimalUser("more context"));

			const sessionFile = sm.getSessionFile();
			expect(sessionFile).toBeDefined();
			if (sessionFile === undefined) return;

			const raw = readFileSync(sessionFile, "utf8");
			const lines = raw.trim().split("\n");
			expect(lines.length).toBeGreaterThanOrEqual(3);

			const header = JSON.parse(lines[0] ?? "{}") as { version: number; type: string };
			expect(header.type).toBe("session");
			expect(header.version).toBeGreaterThanOrEqual(3);

			const reopened = SessionManager.open(sessionFile);
			const ids = reopened.getEntries().map((e) => e.id);
			expect(ids).toContain(id1);
			expect(ids).toContain(id2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("sessions land under the agentDir we pass in", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-acp-session-default-"));
		try {
			const sm = SessionManager.create(dir, dir);
			sm.appendMessage(minimalUser("x"));
			sm.appendMessage(minimalAssistant("y"));
			expect(sm.getSessionDir().startsWith(dir)).toBe(true);
			expect(readdirSync(sm.getSessionDir()).length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
