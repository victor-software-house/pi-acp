/**
 * ExtMethodDispatcher unit tests — verifies ACP extMethod/extNotification
 * routing under the pi-acp/ namespace.
 */

import { describe, expect, test } from "bun:test";

import { ExtMethodDispatcher } from "@pi-acp/acp/ext-methods";

function makeDispatcher(): ExtMethodDispatcher {
	return new ExtMethodDispatcher({
		version: "0.13.1-test",
		startedAt: Date.now() - 1000,
		sessionCount: () => 3,
	});
}

describe("ExtMethodDispatcher built-in handlers", () => {
	test("pi-acp/ping returns ok + ts", async () => {
		const d = makeDispatcher();
		const r = await d.handleRequest("pi-acp/ping", {});
		expect(r["ok"]).toBe(true);
		expect(typeof r["ts"]).toBe("number");
	});

	test("pi-acp/runtime-info returns version/uptime/sessionCount", async () => {
		const d = makeDispatcher();
		const r = await d.handleRequest("pi-acp/runtime-info", {});
		expect(r["version"]).toBe("0.13.1-test");
		expect(typeof r["uptimeMs"]).toBe("number");
		expect(r["uptimeMs"] as number).toBeGreaterThanOrEqual(1000);
		expect(r["sessionCount"]).toBe(3);
	});
});

describe("ExtMethodDispatcher request routing", () => {
	test("unknown method throws methodNotFound (code -32601)", async () => {
		const d = makeDispatcher();
		try {
			await d.handleRequest("unknown/method", {});
			throw new Error("expected throw");
		} catch (e: unknown) {
			const err = e as { code?: number };
			expect(err.code).toBe(-32601);
		}
	});

	test("registered handler receives params + return value", async () => {
		const d = makeDispatcher();
		d.register("test/echo", (params) => ({ got: params }));
		const r = await d.handleRequest("test/echo", { hello: "world" });
		expect(r).toEqual({ got: { hello: "world" } });
	});
});

describe("ExtMethodDispatcher notification routing", () => {
	test("registered notification handler is invoked with params", async () => {
		const d = makeDispatcher();
		const captured: Record<string, unknown>[] = [];
		d.registerNotification("test/event", (params) => {
			captured.push(params);
		});
		await d.handleNotification("test/event", { fired: true });
		expect(captured).toHaveLength(1);
		expect(captured[0]).toEqual({ fired: true });
	});

	test("unknown notification is silently ignored (no throw)", async () => {
		const d = makeDispatcher();
		await expect(d.handleNotification("unknown/event", {})).resolves.toBeUndefined();
	});
});
