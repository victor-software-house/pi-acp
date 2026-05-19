import { describe, expect, test } from "bun:test";
import { parseClientCapabilities } from "@pi-acp/acp/client-capabilities";

describe("parseClientCapabilities", () => {
	test("returns all false for undefined", () => {
		const flags = parseClientCapabilities(undefined);
		expect(flags.terminalOutput).toBe(false);
		expect(flags.terminalAuth).toBe(false);
		expect(flags.gatewayAuth).toBe(false);
	});

	test("returns all false for null", () => {
		const flags = parseClientCapabilities(null);
		expect(flags.terminalOutput).toBe(false);
		expect(flags.terminalAuth).toBe(false);
		expect(flags.gatewayAuth).toBe(false);
	});

	test("returns all false for empty object", () => {
		const flags = parseClientCapabilities({});
		expect(flags.terminalOutput).toBe(false);
		expect(flags.terminalAuth).toBe(false);
		expect(flags.gatewayAuth).toBe(false);
	});

	test("detects terminal_output from _meta", () => {
		const flags = parseClientCapabilities({
			_meta: { terminal_output: true },
		});
		expect(flags.terminalOutput).toBe(true);
		expect(flags.terminalAuth).toBe(false);
	});

	test("detects terminal-auth from _meta", () => {
		const flags = parseClientCapabilities({
			_meta: { "terminal-auth": true },
		});
		expect(flags.terminalAuth).toBe(true);
		expect(flags.terminalOutput).toBe(false);
	});

	test("detects gateway auth from auth._meta.gateway", () => {
		const flags = parseClientCapabilities({
			auth: { _meta: { gateway: true } },
		});
		expect(flags.gatewayAuth).toBe(true);
	});

	test("detects all capabilities simultaneously", () => {
		const flags = parseClientCapabilities({
			_meta: { terminal_output: true, "terminal-auth": true },
			auth: { _meta: { gateway: true } },
		});
		expect(flags.terminalOutput).toBe(true);
		expect(flags.terminalAuth).toBe(true);
		expect(flags.gatewayAuth).toBe(true);
	});

	test("handles non-boolean values gracefully", () => {
		const flags = parseClientCapabilities({
			_meta: { terminal_output: "yes", "terminal-auth": 1 },
		});
		// Strict equality: only `true` matches, not "yes" or 1
		expect(flags.terminalOutput).toBe(false);
		expect(flags.terminalAuth).toBe(false);
	});

	test("handles _meta that is not an object", () => {
		// Force a non-object _meta to test defensive parsing
		const caps = { _meta: "not-an-object" } as unknown as Record<string, unknown>;
		const flags = parseClientCapabilities(caps);
		expect(flags.terminalOutput).toBe(false);
		expect(flags.terminalAuth).toBe(false);
	});

	test("handles missing auth._meta", () => {
		const flags = parseClientCapabilities({
			auth: {},
		});
		expect(flags.gatewayAuth).toBe(false);
	});

	test("detects fs.readTextFile capability", () => {
		const flags = parseClientCapabilities({ fs: { readTextFile: true } });
		expect(flags.fsReadTextFile).toBe(true);
	});

	test("fsReadTextFile false when fs absent", () => {
		const flags = parseClientCapabilities({});
		expect(flags.fsReadTextFile).toBe(false);
	});

	test("fsReadTextFile false when fs.readTextFile explicitly false", () => {
		const flags = parseClientCapabilities({ fs: { readTextFile: false } });
		expect(flags.fsReadTextFile).toBe(false);
	});

	test("detects terminal capability", () => {
		const flags = parseClientCapabilities({ terminal: true });
		expect(flags.terminal).toBe(true);
	});

	test("terminal false when absent", () => {
		const flags = parseClientCapabilities({});
		expect(flags.terminal).toBe(false);
	});
});
