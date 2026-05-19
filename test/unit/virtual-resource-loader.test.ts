import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualResourceLoader } from "@pi-acp/resources/loader";
import type { ResourceSource } from "@pi-acp/resources/sources/base";
import { LocalBackend } from "@pi-acp/resources/sources/local";

function makeLocal(): { local: LocalBackend; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "virtloader-test-"));
	const local = new LocalBackend({ cwd: dir, agentDir: dir });
	return { local, dir };
}

class FakeSource implements ResourceSource {
	readonly kind = "ssh" as const;
	constructor(
		readonly id: string,
		private readonly skills: { name: string; description?: string }[] = [],
		private readonly prompts: { name: string }[] = [],
		private readonly agentsFiles: { path: string; content: string }[] = [],
	) {}
	async reload(): Promise<void> {}
	getAgentsFiles() {
		return this.agentsFiles;
	}
	getSkills() {
		return {
			skills: this.skills.map((s) => ({
				name: s.name,
				path: `/fake/${s.name}`,
				description: s.description,
			})) as never,
			diagnostics: [],
		};
	}
	getPrompts() {
		return {
			prompts: this.prompts.map((p) => ({ name: p.name, content: "" })) as never,
			diagnostics: [],
		};
	}
	getExtensions() {
		return { extensions: [], errors: [], runtime: {} as never };
	}
	getSystemPrompt(): string | undefined {
		return undefined;
	}
	getAppendSystemPrompt(): string[] {
		return [];
	}
}

describe("VirtualResourceLoader", () => {
	test("rejects empty sources", () => {
		expect(() => new VirtualResourceLoader({ sources: [] })).toThrow(/at least one source/);
	});

	test("rejects sources without a LocalBackend", () => {
		const fake = new FakeSource("ssh-only");
		expect(() => new VirtualResourceLoader({ sources: [fake] })).toThrow(
			/at least one LocalBackend is required/,
		);
	});

	test("single LocalBackend behaves as a pass-through", async () => {
		const { local, dir } = makeLocal();
		try {
			const loader = new VirtualResourceLoader({ sources: [local] });
			await loader.reload();
			expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
			expect(loader.getSkills().skills.length).toBeGreaterThanOrEqual(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("append strategy concatenates skills from multiple sources", async () => {
		const { local, dir } = makeLocal();
		try {
			const fakeA = new FakeSource("fake-a", [{ name: "alpha" }, { name: "beta" }]);
			const fakeB = new FakeSource("fake-b", [{ name: "gamma" }]);
			const loader = new VirtualResourceLoader({
				sources: [local, fakeA, fakeB],
				mergeStrategy: "append",
			});
			await loader.reload();
			const names = loader.getSkills().skills.map((s) => s.name);
			expect(names).toContain("alpha");
			expect(names).toContain("beta");
			expect(names).toContain("gamma");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("override-by-name strategy lets later sources replace by skill name", async () => {
		const { local, dir } = makeLocal();
		try {
			const fakeA = new FakeSource("fake-a", [{ name: "alpha", description: "from A" }]);
			const fakeB = new FakeSource("fake-b", [{ name: "alpha", description: "from B" }]);
			const loader = new VirtualResourceLoader({
				sources: [local, fakeA, fakeB],
				mergeStrategy: "override-by-name",
			});
			await loader.reload();
			const alpha = loader.getSkills().skills.find((s) => s.name === "alpha");
			expect(alpha?.description).toBe("from B");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AGENTS files are deduped by path across sources", async () => {
		const { local, dir } = makeLocal();
		try {
			const fakeA = new FakeSource("fake-a", [], [], [{ path: "/x/AGENTS.md", content: "alpha" }]);
			const fakeB = new FakeSource(
				"fake-b",
				[],
				[],
				[
					{ path: "/x/AGENTS.md", content: "beta" },
					{ path: "/y/AGENTS.md", content: "gamma" },
				],
			);
			const loader = new VirtualResourceLoader({ sources: [local, fakeA, fakeB] });
			await loader.reload();
			const files = loader.getAgentsFiles().agentsFiles;
			expect(files.length).toBe(2);
			expect(files.find((f) => f.path === "/x/AGENTS.md")?.content).toBe("alpha");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
