import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { piChangelogPath, piCliEntry, piPackageRoot } from "@pi-acp/pi-package";

describe("pi-package resolver", () => {
	test("resolves pi package root via node_modules", () => {
		const root = piPackageRoot();
		expect(existsSync(root)).toBe(true);
		expect(existsSync(`${root}/package.json`)).toBe(true);
	});

	test("piCliEntry points at an existing cli.js", () => {
		expect(existsSync(piCliEntry())).toBe(true);
	});

	test("piChangelogPath resolves to the shipped CHANGELOG", () => {
		expect(existsSync(piChangelogPath())).toBe(true);
	});
});
