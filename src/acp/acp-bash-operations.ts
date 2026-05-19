/**
 * PRD-002 §FR-6.5 — ACP terminal delegation for pi's `bash` tool.
 *
 * Companion to acp-read-operations.ts. When the client advertises
 * `clientCapabilities.terminal === true`, pi-acp overrides pi's built-in
 * `bash` with an ACP-routed implementation. Commands run on the CLIENT'S
 * machine via `terminal/*` lifecycle, so Zed Remote workflows execute
 * `bash` on the remote workspace where the user actually edits — matching
 * the FR-6 `read` delegation behavior so the full read/bash pair is
 * coherent.
 *
 * Pi exposes `BashOperations.exec(command, cwd, { onData, signal, timeout, env })`
 * with a streaming `onData(Buffer)` callback. ACP's TerminalHandle exposes
 * `currentOutput()` returning a snapshot string. We bridge by polling
 * `currentOutput()` while `waitForExit()` is pending and computing
 * length-prefix deltas, then emitting `onData(Buffer.from(delta, "utf8"))`.
 *
 * Command + args: pi passes a single shell-string `command`. We wrap as
 * `command: "/bin/sh", args: ["-c", command]` to preserve shell semantics
 * (pipes, redirects, expansion). Zed's terminal implementation accepts
 * this verbatim — same pattern Codex and Claude ACP use.
 *
 * Cancellation: pi's options.signal is honored by calling `terminal.kill()`
 * then awaiting release. The poll loop also self-aborts on signal.
 *
 * SessionId binding: same late-ref pattern as acp-read-operations — the
 * id ref is mutated by PiAcpAgent right after createAgentSession returns,
 * before any tool turn can run.
 */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface AcpBashOperationsDeps {
	conn: AgentSideConnection;
	getSessionId: () => string;
}

const POLL_INTERVAL_MS = 100;
const SHELL_PATH = "/bin/sh";

export function createAcpBashOperations(deps: AcpBashOperationsDeps): BashOperations {
	const { conn, getSessionId } = deps;

	return {
		async exec(command, cwd, options) {
			const sessionId = getSessionId();
			if (sessionId === "") {
				throw new Error("pi-acp acp-bash: sessionId not yet bound");
			}

			const env =
				options.env !== undefined
					? Object.entries(options.env)
							.filter(([, v]) => v !== undefined)
							.map(([name, value]) => ({ name, value: String(value) }))
					: [];

			const createParams: Parameters<AgentSideConnection["createTerminal"]>[0] = {
				sessionId,
				command: SHELL_PATH,
				args: ["-c", command],
				cwd,
				env,
			};

			const terminal = await conn.createTerminal(createParams);

			let lastOutputLen = 0;
			let cancelled = false;
			const abortHandler = (): void => {
				cancelled = true;
				void terminal.kill().catch(() => {});
			};
			options.signal?.addEventListener("abort", abortHandler);

			// Background poll for incremental stdout. Diffs against the
			// previous full snapshot length and pushes the new tail through
			// onData. ACP's terminal contract guarantees output only grows
			// (it can be truncated from the START on byte-limit overflow,
			// but we don't pass outputByteLimit so that's not in play).
			const pollLoop = async (): Promise<void> => {
				while (!cancelled) {
					try {
						const snap = await terminal.currentOutput();
						if (snap.output.length > lastOutputLen) {
							const delta = snap.output.slice(lastOutputLen);
							lastOutputLen = snap.output.length;
							options.onData(Buffer.from(delta, "utf8"));
						}
						if (snap.exitStatus !== null && snap.exitStatus !== undefined) return;
					} catch {
						// Terminal already released or transport blip — exit loop;
						// waitForExit will surface the real outcome.
						return;
					}
					await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
				}
			};

			const timeoutPromise =
				options.timeout !== undefined && options.timeout > 0
					? new Promise<{ timedOut: true }>((resolve) =>
							setTimeout(() => resolve({ timedOut: true }), options.timeout),
						)
					: null;

			try {
				const pollPromise = pollLoop();
				const exitPromise = terminal.waitForExit();
				const winner =
					timeoutPromise !== null
						? await Promise.race([exitPromise, timeoutPromise])
						: await exitPromise;

				let exitCode: number | null;
				if ("timedOut" in winner) {
					await terminal.kill().catch(() => {});
					const final = await terminal.waitForExit();
					exitCode = final.exitCode ?? null;
				} else {
					exitCode = winner.exitCode ?? null;
				}

				// Drain any final output the poll loop may have missed.
				cancelled = true;
				await pollPromise;
				try {
					const final = await terminal.currentOutput();
					if (final.output.length > lastOutputLen) {
						const delta = final.output.slice(lastOutputLen);
						options.onData(Buffer.from(delta, "utf8"));
					}
				} catch {
					/* best-effort */
				}

				return { exitCode };
			} finally {
				options.signal?.removeEventListener("abort", abortHandler);
				try {
					await terminal.release();
				} catch {
					/* best-effort — terminal may already be released */
				}
			}
		},
	};
}
