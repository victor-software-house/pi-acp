/**
 * ACP `extMethod` / `extNotification` dispatcher.
 *
 * ACP spec recommends prefixing extension method names with a unique
 * identifier (e.g., a domain name). pi-acp uses the `pi-acp/` prefix for
 * its built-ins; client-defined methods can also be routed here by
 * registering handlers via `register()`.
 *
 * Unknown request methods throw `RequestError.methodNotFound`. Unknown
 * notification methods are silently ignored per JSON-RPC 2.0 semantics —
 * notifications have no response channel, so erroring is meaningless.
 */

import { RequestError } from "@agentclientprotocol/sdk";

export type ExtMethodRequestHandler = (
	params: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type ExtNotificationHandler = (params: Record<string, unknown>) => Promise<void> | void;

export interface ExtDispatcherDeps {
	/** Version string surfaced via `pi-acp/runtime-info`. */
	version: string;
	/** Returns the current count of locally-tracked sessions. */
	sessionCount: () => number;
	/** Process start time in ms epoch, used to compute uptime. */
	startedAt: number;
}

export class ExtMethodDispatcher {
	private readonly requestHandlers = new Map<string, ExtMethodRequestHandler>();
	private readonly notificationHandlers = new Map<string, ExtNotificationHandler>();

	constructor(deps: ExtDispatcherDeps) {
		// Built-in request handlers under the pi-acp/ namespace.
		this.requestHandlers.set("pi-acp/ping", () => ({ ok: true, ts: Date.now() }));
		this.requestHandlers.set("pi-acp/runtime-info", () => ({
			version: deps.version,
			uptimeMs: Date.now() - deps.startedAt,
			sessionCount: deps.sessionCount(),
		}));
	}

	register(method: string, handler: ExtMethodRequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	registerNotification(method: string, handler: ExtNotificationHandler): void {
		this.notificationHandlers.set(method, handler);
	}

	async handleRequest(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const handler = this.requestHandlers.get(method);
		if (handler === undefined) throw RequestError.methodNotFound(method);
		return await handler(params);
	}

	async handleNotification(method: string, params: Record<string, unknown>): Promise<void> {
		const handler = this.notificationHandlers.get(method);
		if (handler === undefined) return;
		await handler(params);
	}
}
