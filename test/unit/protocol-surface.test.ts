import { describe, expect, test } from "bun:test";
import type { AuthenticateRequest } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "@pi-acp/acp/agent";
import { asAgentConn, FakeAgentSideConnection } from "../helpers/fakes";

function createAgent() {
	const conn = new FakeAgentSideConnection();
	return new PiAcpAgent(asAgentConn(conn));
}

async function initAgent() {
	const agent = createAgent();
	return agent.initialize({
		protocolVersion: 1,
		clientInfo: { name: "test-client", version: "1.0.0" },
	});
}

describe("protocol surface: initialize", () => {
	test("returns protocol version 1 when client requests 1", async () => {
		const response = await initAgent();
		expect(response.protocolVersion).toBe(1);
	});

	test("falls back to version 1 when client requests unsupported version", async () => {
		const agent = createAgent();
		const response = await agent.initialize({
			protocolVersion: 99,
			clientInfo: { name: "test-client", version: "1.0.0" },
		});
		expect(response.protocolVersion).toBe(1);
	});

	test("returns agent info with name and version", async () => {
		const response = await initAgent();
		expect(response.agentInfo).toBeDefined();
		// agentInfo is defined per the above assertion -- access safely
		const info = response.agentInfo;
		if (info === undefined || info === null) throw new Error("agentInfo missing");
		expect(info.name).toBeTruthy();
		expect(info.version).toBeTruthy();
	});

	test("advertises loadSession capability", async () => {
		const response = await initAgent();
		const caps = response.agentCapabilities;
		if (caps === undefined) throw new Error("agentCapabilities missing");
		expect(caps.loadSession).toBe(true);
	});

	test("advertises session capabilities: list, close, resume, fork", async () => {
		const response = await initAgent();
		const caps = response.agentCapabilities;
		if (caps === undefined) throw new Error("agentCapabilities missing");
		const sc = caps.sessionCapabilities;
		if (sc === undefined || sc === null) throw new Error("sessionCapabilities missing");
		expect(sc.list).toBeDefined();
		expect(sc.close).toBeDefined();
		expect(sc.resume).toBeDefined();
		expect(sc.fork).toBeDefined();
	});

	test("advertises prompt capabilities with embeddedContext", async () => {
		const response = await initAgent();
		const caps = response.agentCapabilities;
		if (caps === undefined) throw new Error("agentCapabilities missing");
		expect(caps.promptCapabilities?.image).toBe(true);
		expect(caps.promptCapabilities?.embeddedContext).toBe(true);
		expect(caps.promptCapabilities?.audio).toBe(false);
	});

	test("returns auth methods", async () => {
		const response = await initAgent();
		expect(response.authMethods).toBeDefined();
		expect(Array.isArray(response.authMethods)).toBe(true);
	});
});

describe("protocol surface: authenticate", () => {
	test("returns empty object", async () => {
		const agent = createAgent();
		// AuthenticateRequest requires methodId; provide a minimal valid request.
		const response = await agent.authenticate({ methodId: "env_var" } as AuthenticateRequest);
		expect(response).toEqual({});
	});
});

describe("protocol surface: newSession", () => {
	test("rejects non-absolute cwd", () => {
		const agent = createAgent();
		expect(agent.newSession({ cwd: "relative/path", mcpServers: [] })).rejects.toThrow();
	});
});

describe("protocol surface: loadSession", () => {
	test("rejects non-absolute cwd", () => {
		const agent = createAgent();
		expect(
			agent.loadSession({ sessionId: "test", cwd: "relative/path", mcpServers: [] }),
		).rejects.toThrow();
	});
});

describe("protocol surface: unstable_closeSession", () => {
	test("rejects unknown session", () => {
		const agent = createAgent();
		expect(agent.unstable_closeSession({ sessionId: "nonexistent" })).rejects.toThrow();
	});
});

describe("protocol surface: unstable_resumeSession", () => {
	test("rejects non-absolute cwd", () => {
		const agent = createAgent();
		expect(
			agent.unstable_resumeSession({ sessionId: "test", cwd: "relative/path" }),
		).rejects.toThrow();
	});
});

describe("protocol surface: unstable_forkSession", () => {
	test("rejects non-absolute cwd", () => {
		const agent = createAgent();
		expect(
			agent.unstable_forkSession({ sessionId: "test", cwd: "relative/path", mcpServers: [] }),
		).rejects.toThrow();
	});
});
