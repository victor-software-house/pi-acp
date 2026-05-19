/**
 * PRD-002 §FR-5 cwd-modes: resolveMode unit tests.
 * Verifies passthrough semantics for `local`/`overlay` and the ephemeral
 * tmpdir + cleanup contract for `none`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";

import { resolveMode } from "@pi-acp/resources/modes";

const createdDirs: string[] = [];

function track(dir: string): string {
	createdDirs.push(dir);
	return dir;
}

afterEach(() => {
	// Defensive: if a test leaks a tmpdir, the cleanup field on the result
	// should have removed it. Track + assert below in each `none` test.
	createdDirs.length = 0;
});

describe("resolveMode — local", () => {
	test("passes requestedCwd through and ephemeral=false", () => {
		const result = resolveMode({
			manifest: {
				version: 1,
				mode: "local",
				roots: [],
				mergeStrategy: "append",
				diagnostics: false,
			},
			requestedCwd: "/abs/path",
		});
		expect(result.mode).toBe("local");
		expect(result.cwd).toBe("/abs/path");
		expect(result.ephemeral).toBe(false);
		expect(typeof result.cleanup).toBe("function");
		// cleanup is a no-op for non-ephemeral modes
		expect(() => {
			result.cleanup();
		}).not.toThrow();
	});
});

describe("resolveMode — overlay", () => {
	test("behaves identically to local (cwd passthrough)", () => {
		const result = resolveMode({
			manifest: {
				version: 1,
				mode: "overlay",
				roots: [],
				mergeStrategy: "append",
				diagnostics: false,
			},
			requestedCwd: "/some/where",
		});
		expect(result.mode).toBe("overlay");
		expect(result.cwd).toBe("/some/where");
		expect(result.ephemeral).toBe(false);
	});
});

describe("resolveMode — none", () => {
	test("mints an ephemeral tmpdir and reports ephemeral=true", () => {
		const result = resolveMode({
			manifest: {
				version: 1,
				mode: "none",
				roots: [],
				mergeStrategy: "append",
				diagnostics: false,
			},
			requestedCwd: "/ignored",
		});
		track(result.cwd);
		expect(result.mode).toBe("none");
		expect(result.ephemeral).toBe(true);
		expect(result.cwd).not.toBe("/ignored");
		expect(result.cwd).toMatch(/pi-acp-session-/);
		expect(existsSync(result.cwd)).toBe(true);

		result.cleanup();
		expect(existsSync(result.cwd)).toBe(false);
	});

	test("cleanup is idempotent — second call is a no-op", () => {
		const result = resolveMode({
			manifest: {
				version: 1,
				mode: "none",
				roots: [],
				mergeStrategy: "append",
				diagnostics: false,
			},
			requestedCwd: "/x",
		});
		track(result.cwd);
		result.cleanup();
		expect(() => {
			result.cleanup();
		}).not.toThrow();
		expect(existsSync(result.cwd)).toBe(false);
	});

	test("cleanup never throws even if the directory is missing", () => {
		const result = resolveMode({
			manifest: {
				version: 1,
				mode: "none",
				roots: [],
				mergeStrategy: "append",
				diagnostics: false,
			},
			requestedCwd: "/x",
		});
		track(result.cwd);
		// Simulate external removal before cleanup runs
		rmSync(result.cwd, { recursive: true, force: true });
		expect(existsSync(result.cwd)).toBe(false);
		expect(() => {
			result.cleanup();
		}).not.toThrow();
	});

	test("two none-mode sessions get distinct tmpdirs", () => {
		const a = resolveMode({
			manifest: {
				version: 1,
				mode: "none",
				roots: [],
				mergeStrategy: "append",
				diagnostics: false,
			},
			requestedCwd: "/x",
		});
		const b = resolveMode({
			manifest: {
				version: 1,
				mode: "none",
				roots: [],
				mergeStrategy: "append",
				diagnostics: false,
			},
			requestedCwd: "/x",
		});
		track(a.cwd);
		track(b.cwd);
		expect(a.cwd).not.toBe(b.cwd);
		expect(existsSync(a.cwd)).toBe(true);
		expect(existsSync(b.cwd)).toBe(true);
		a.cleanup();
		b.cleanup();
	});
});
