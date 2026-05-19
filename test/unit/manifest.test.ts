import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "@pi-acp/resources/manifest";
import { DEFAULT_MANIFEST, ManifestSchema } from "@pi-acp/resources/manifest.schema";

function fixtureDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-acp-manifest-"));
}

describe("manifest schema", () => {
	test("rejects unknown version", () => {
		const result = ManifestSchema.safeParse({ version: 2 });
		expect(result.success).toBe(false);
	});

	test("accepts a minimal version: 1 manifest with defaults filled in", () => {
		const result = ManifestSchema.safeParse({ version: 1 });
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.mode).toBe("local");
		expect(result.data.mergeStrategy).toBe("append");
		expect(result.data.roots).toEqual([]);
		expect(result.data.diagnostics).toBe(false);
	});

	test("validates discriminated kinds", () => {
		const good = ManifestSchema.safeParse({
			version: 1,
			roots: [
				{ id: "a", kind: "local", paths: { cwd: "/tmp/a" } },
				{ id: "b", kind: "ssh", host: "cvm", user: "varaujo" },
				{ id: "c", kind: "http", baseUrl: "https://example.test/r" },
				{ id: "d", kind: "acp-fs" },
			],
		});
		expect(good.success).toBe(true);

		const badHttpScheme = ManifestSchema.safeParse({
			version: 1,
			roots: [{ id: "x", kind: "http", baseUrl: "http://insecure.test" }],
		});
		expect(badHttpScheme.success).toBe(false);

		const badKind = ManifestSchema.safeParse({
			version: 1,
			roots: [{ id: "x", kind: "bogus" }],
		});
		expect(badKind.success).toBe(false);
	});
});

describe("manifest cascade", () => {
	test("synthesized default when no file present and no session params", async () => {
		const dir = fixtureDir();
		try {
			const result = await loadManifest({ cwd: dir, sessionParams: undefined });
			expect(result.source).toBe("default");
			expect(result.manifest).toEqual(DEFAULT_MANIFEST);
			expect(result.diagnostics).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("project-level .pi-acp.yaml is picked up", async () => {
		const dir = fixtureDir();
		try {
			writeFileSync(
				join(dir, ".pi-acp.yaml"),
				`version: 1
mode: overlay
roots:
  - id: alpha
    kind: local
    paths:
      cwd: ${dir}
mergeStrategy: override-by-name
`,
			);
			const result = await loadManifest({ cwd: dir, sessionParams: undefined });
			expect(result.source).toBe("project");
			expect(result.manifest.mode).toBe("overlay");
			expect(result.manifest.mergeStrategy).toBe("override-by-name");
			expect(result.manifest.roots).toHaveLength(1);
			expect(result.manifest.roots[0]?.id).toBe("alpha");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ACP session-params manifest overrides project file", async () => {
		const dir = fixtureDir();
		try {
			writeFileSync(
				join(dir, ".pi-acp.yaml"),
				`version: 1
mode: overlay
`,
			);
			const inline = { version: 1, mode: "none" } as const;
			const result = await loadManifest({
				cwd: dir,
				sessionParams: { _meta: { piAcp: { manifest: inline } } },
			});
			expect(result.source).toBe("session-params");
			expect(result.manifest.mode).toBe("none");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ACP session-params can point at a path string", async () => {
		const dir = fixtureDir();
		const manifestPath = join(dir, "alt.yaml");
		try {
			writeFileSync(manifestPath, `version: 1\nmode: overlay\n`);
			const result = await loadManifest({
				cwd: dir,
				sessionParams: { _meta: { piAcp: { manifest: manifestPath } } },
			});
			expect(result.source).toBe("session-params");
			expect(result.path).toBe(manifestPath);
			expect(result.manifest.mode).toBe("overlay");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("invalid YAML at project layer falls through to default + diagnostic", async () => {
		const dir = fixtureDir();
		try {
			writeFileSync(join(dir, ".pi-acp.yaml"), "version: 1\nmode: : :");
			const result = await loadManifest({ cwd: dir, sessionParams: undefined });
			expect(result.source).toBe("default");
			expect(result.diagnostics.length).toBeGreaterThan(0);
			expect(result.diagnostics[0]?.source).toBe("project");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("schema-invalid project manifest falls through with diagnostic", async () => {
		const dir = fixtureDir();
		try {
			writeFileSync(join(dir, ".pi-acp.yaml"), `version: 99\n`);
			const result = await loadManifest({ cwd: dir, sessionParams: undefined });
			expect(result.source).toBe("default");
			const diag = result.diagnostics.find((d) => d.source === "project");
			expect(diag).toBeDefined();
			expect(diag?.message).toContain("schema validation failed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("nested .pi-acp.yaml in subdir is not visible from sibling cwd", async () => {
		const root = fixtureDir();
		const sub = join(root, "sub");
		mkdirSync(sub);
		try {
			writeFileSync(join(sub, ".pi-acp.yaml"), `version: 1\nmode: overlay\n`);
			const result = await loadManifest({ cwd: root, sessionParams: undefined });
			expect(result.source).toBe("default");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
