import { describe, expect, test } from "bun:test";
import { PiAcpAgent } from "@pi-acp/acp/agent";
import { createDaemonContext } from "@pi-acp/daemon/context";
import { asAgentConn, FakeAgentSideConnection } from "../helpers/fakes";

describe("multi-client SessionRegistry", () => {
	test("dispose releases owned sessions from the shared registry", () => {
		const ctx = createDaemonContext();
		const aConn = new FakeAgentSideConnection();
		const bConn = new FakeAgentSideConnection();
		const agentA = new PiAcpAgent(asAgentConn(aConn), ctx);
		const agentB = new PiAcpAgent(asAgentConn(bConn), ctx);

		// Drive both agents through a shared registry, then dispose A and
		// confirm only A's registrations are gone.
		ctx.sessionRegistry.register({
			sessionId: "s-owned-by-A",
			piSession: {} as never,
			ownerConnectionId: getConnectionId(agentA),
			cwd: "/x",
			sessionFile: undefined,
		});
		ctx.sessionRegistry.register({
			sessionId: "s-owned-by-B",
			piSession: {} as never,
			ownerConnectionId: getConnectionId(agentB),
			cwd: "/y",
			sessionFile: undefined,
		});
		ctx.sessionRegistry.attach("s-owned-by-A", getConnectionId(agentB));

		agentA.dispose();

		// A's session transferred ownership to B (still held)
		const sA = ctx.sessionRegistry.get("s-owned-by-A");
		expect(sA).toBeDefined();
		expect(sA?.ownerConnectionId).toBe(getConnectionId(agentB));

		// B's session untouched
		expect(ctx.sessionRegistry.get("s-owned-by-B")).toBeDefined();
	});

	test("listAll exposes sessions across multiple PiAcpAgent instances", () => {
		const ctx = createDaemonContext();
		const aConn = new FakeAgentSideConnection();
		const bConn = new FakeAgentSideConnection();
		const agentA = new PiAcpAgent(asAgentConn(aConn), ctx);
		const agentB = new PiAcpAgent(asAgentConn(bConn), ctx);

		ctx.sessionRegistry.register({
			sessionId: "s1",
			piSession: {} as never,
			ownerConnectionId: getConnectionId(agentA),
			cwd: "/a",
			sessionFile: undefined,
		});
		ctx.sessionRegistry.register({
			sessionId: "s2",
			piSession: {} as never,
			ownerConnectionId: getConnectionId(agentB),
			cwd: "/b",
			sessionFile: undefined,
		});

		expect(ctx.sessionRegistry.listAll().length).toBe(2);
	});
});

// Connection IDs are private to PiAcpAgent. For the test we reach in via a
// runtime cast — this is intentional and bounded to the test helper.
function getConnectionId(agent: PiAcpAgent): string {
	const id = (agent as unknown as { connectionId: string }).connectionId;
	if (typeof id !== "string") throw new Error("connectionId missing");
	return id;
}
