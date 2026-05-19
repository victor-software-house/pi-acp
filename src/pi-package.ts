/**
 * Helpers to locate the bundled `@earendil-works/pi-coding-agent` package on
 * disk so we can resolve its CLI binary and CHANGELOG without depending on a
 * `pi` command being globally on PATH.
 *
 * Pi is a regular npm dependency — it's installed alongside pi-acp under
 * node_modules. `import.meta.resolve` finds its `package.json`; we derive the
 * sibling paths from there.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function piPackageRoot(): string {
	if (cached !== undefined) return cached;
	const pkgUrl = import.meta.resolve("@earendil-works/pi-coding-agent/package.json");
	cached = dirname(fileURLToPath(pkgUrl));
	return cached;
}

export function piCliEntry(): string {
	return join(piPackageRoot(), "dist", "cli.js");
}

export function piChangelogPath(): string {
	return join(piPackageRoot(), "CHANGELOG.md");
}
