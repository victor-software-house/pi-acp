/**
 * PRD-002 §FR-6 — ACP-FS delegation for the `read` tool.
 *
 * Pi exposes a `ReadOperations` seam on its built-in read tool
 * (`createReadToolDefinition(cwd, { operations })`). When an ACP client
 * advertises `clientCapabilities.fs.readTextFile`, pi-acp swaps the
 * default node-fs operations for ACP-routed ones so `read` lands on the
 * client's filesystem (which Zed Remote forwards to the remote machine).
 *
 * The sessionId is captured via a getter callback because for newSession /
 * forkSession the id is generated *inside* `createAgentSession`, after
 * `customTools` (which embed these operations) have already been built.
 * The ref is mutated by the agent immediately after session creation and
 * before the model can invoke any tool, so by the time `readFile` runs
 * the getter returns the canonical sessionId.
 *
 * Mandatory skill: `pi-tool-progressive-disclosure` — the override keeps
 * the same tool name + argument schema as pi's built-in so the model is
 * unaware of the indirection.
 */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { ReadOperations } from "@earendil-works/pi-coding-agent";

export interface AcpReadOperationsDeps {
	conn: AgentSideConnection;
	/**
	 * Lazy sessionId provider. Called per-operation. Returning an empty
	 * string causes the tool to throw — the model never sees a stale id.
	 */
	getSessionId: () => string;
}

export function createAcpReadOperations(deps: AcpReadOperationsDeps): ReadOperations {
	const { conn, getSessionId } = deps;

	return {
		async readFile(absolutePath: string): Promise<Buffer> {
			const sessionId = getSessionId();
			if (sessionId === "") {
				throw new Error("pi-acp acp-fs read: sessionId not yet bound");
			}
			const response = await conn.readTextFile({ sessionId, path: absolutePath });
			return Buffer.from(response.content, "utf8");
		},
		async access(absolutePath: string): Promise<void> {
			const sessionId = getSessionId();
			if (sessionId === "") {
				throw new Error("pi-acp acp-fs access: sessionId not yet bound");
			}
			// ACP has no explicit access primitive — a successful read is the
			// only way to confirm readability. Discard the body.
			await conn.readTextFile({ sessionId, path: absolutePath });
		},
		// detectImageMimeType intentionally omitted — ACP fs/read_text_file
		// returns text content only; image detection would need an out-of-
		// band probe that ACP doesn't currently expose.
	};
}
