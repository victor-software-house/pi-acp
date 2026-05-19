import { describe, expect, test } from "bun:test";
import { createDaemonContext } from "@pi-acp/daemon/context";
import { buildControlApp, type ControlContext } from "@pi-acp/daemon/control";

function makeControl(overrides: Partial<ControlContext> = {}): ControlContext {
	const ctx = createDaemonContext();
	let shutdownCalled = false;
	return {
		ctx,
		startedAt: Date.now() - 5_000,
		pid: 12345,
		version: "9.9.9",
		activeConnections: () => 0,
		onShutdown: () => {
			shutdownCalled = true;
		},
		...overrides,
		// expose for inspection by mutating into metadata after
		// eslint-disable-next-line
		_shutdownCalled: () => shutdownCalled,
	} as ControlContext;
}

describe("control HTTP app", () => {
	test("GET /status returns the shape operator clients expect", async () => {
		const app = buildControlApp(makeControl({ activeConnections: () => 2 }));
		const res = await app.fetch(new Request("http://daemon/status"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			pid: number;
			uptimeSeconds: number;
			version: string;
			connections: number;
			sessions: number;
		};
		expect(body.pid).toBe(12345);
		expect(body.version).toBe("9.9.9");
		expect(body.connections).toBe(2);
		expect(body.sessions).toBe(0);
		expect(body.uptimeSeconds).toBeGreaterThanOrEqual(5);
	});

	test("POST /shutdown returns 200 + triggers onShutdown", async () => {
		let called = false;
		const app = buildControlApp(
			makeControl({
				onShutdown: () => {
					called = true;
				},
			}),
		);
		const res = await app.fetch(new Request("http://daemon/shutdown", { method: "POST" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
		// onShutdown is deferred via setImmediate; wait one tick.
		await new Promise((r) => setImmediate(r));
		expect(called).toBe(true);
	});

	test("GET /sessions returns an array (empty by default)", async () => {
		const app = buildControlApp(makeControl());
		const res = await app.fetch(new Request("http://daemon/sessions"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: unknown[] };
		expect(Array.isArray(body.sessions)).toBe(true);
		expect(body.sessions.length).toBe(0);
	});

	test("unknown route returns 404", async () => {
		const app = buildControlApp(makeControl());
		const res = await app.fetch(new Request("http://daemon/nope"));
		expect(res.status).toBe(404);
	});
});
