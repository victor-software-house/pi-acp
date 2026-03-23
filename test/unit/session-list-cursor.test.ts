import { describe, expect, test } from "bun:test";
import { PiAcpAgent } from "@pi-acp/acp/agent";
import { asAgentConn, FakeAgentSideConnection } from "../helpers/fakes";

describe("listSessions cursor validation", () => {
	test("invalid cursor throws invalidParams", () => {
		const conn = new FakeAgentSideConnection();
		const agent = new PiAcpAgent(asAgentConn(conn));
		expect(agent.listSessions({ cursor: "not-a-number" })).rejects.toThrow();
	});

	test("negative cursor throws invalidParams", () => {
		const conn = new FakeAgentSideConnection();
		const agent = new PiAcpAgent(asAgentConn(conn));
		expect(agent.listSessions({ cursor: "-5" })).rejects.toThrow();
	});
});
