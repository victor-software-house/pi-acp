/**
 * buildDiagnosticsReport unit tests — PRD-002 §FR-7. Pure formatting;
 * stub ResourceSource implementations + a synthetic ManifestDiagnostic
 * list verify both happy-path output and the failure-only branch.
 */

import { describe, expect, test } from "bun:test";

import type { PromptTemplate, ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import { buildDiagnosticsReport } from "@pi-acp/resources/diagnostics";
import type { ResourceSource, ResourceSourceKind } from "@pi-acp/resources/sources/base";

interface StubSourceOpts {
	id: string;
	kind: ResourceSourceKind;
	agentsFiles?: Array<{ path: string; content: string }>;
	skills?: Skill[];
	skillsDiagnostics?: ResourceDiagnostic[];
	prompts?: PromptTemplate[];
}

function stubSource(opts: StubSourceOpts): ResourceSource {
	return {
		id: opts.id,
		kind: opts.kind,
		async reload() {},
		getAgentsFiles: () => opts.agentsFiles ?? [],
		getSkills: () => ({ skills: opts.skills ?? [], diagnostics: opts.skillsDiagnostics ?? [] }),
		getPrompts: () => ({ prompts: opts.prompts ?? [], diagnostics: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
	};
}

describe("buildDiagnosticsReport", () => {
	test("empty input yields empty text and empty stats", () => {
		const r = buildDiagnosticsReport({ sources: [], manifestDiagnostics: [] });
		expect(r.text).toBe("");
		expect(r.sourceStats).toEqual([]);
	});

	test("sources only — emits the resources-active block, no failures block", () => {
		const r = buildDiagnosticsReport({
			sources: [
				stubSource({
					id: "local",
					kind: "local",
					agentsFiles: [
						{ path: "/x/AGENTS.md", content: "" },
						{ path: "/x/SECURITY.md", content: "" },
					],
				}),
				stubSource({ id: "vsh", kind: "ssh" }),
			],
			manifestDiagnostics: [],
		});
		expect(r.text).toContain("resources active");
		expect(r.text).toContain("local");
		expect(r.text).toContain("(2 AGENTS files");
		expect(r.text).toContain("vsh");
		expect(r.text).not.toContain("resource failures");
	});

	test("source-level diagnostics surface in the failures block", () => {
		const r = buildDiagnosticsReport({
			sources: [
				stubSource({
					id: "remote",
					kind: "ssh",
					skillsDiagnostics: [{ type: "warning", message: "AGENTS.md unreadable — ssh exited 1" }],
				}),
			],
			manifestDiagnostics: [],
		});
		expect(r.text).toContain("resources active");
		expect(r.text).toContain("resource failures");
		expect(r.text).toContain("AGENTS.md unreadable");
		expect(r.sourceStats[0]?.failures).toHaveLength(1);
	});

	test("manifest-level diagnostics surface in the failures block (no sources)", () => {
		const r = buildDiagnosticsReport({
			sources: [],
			manifestDiagnostics: [
				{
					source: "project",
					path: "/repo/.pi-acp.yaml",
					message: "schema validation failed: bad kind",
				},
			],
		});
		expect(r.text).toContain("resource failures");
		expect(r.text).toContain("/repo/.pi-acp.yaml");
		expect(r.text).toContain("schema validation failed");
	});

	test("combined source + manifest diagnostics in a single failures block", () => {
		const r = buildDiagnosticsReport({
			sources: [
				stubSource({
					id: "team",
					kind: "http",
					skillsDiagnostics: [{ type: "warning", message: "HTTP 404 on AGENTS.md" }],
				}),
			],
			manifestDiagnostics: [
				{
					source: "user-global",
					message: 'root "x" kind="acp-fs" not yet supported (skipped)',
				},
			],
		});
		expect(r.text).toContain("HTTP 404");
		expect(r.text).toContain("acp-fs");
	});

	test("source stats track agentsFiles, skills, prompts counts", () => {
		const r = buildDiagnosticsReport({
			sources: [
				stubSource({
					id: "local",
					kind: "local",
					agentsFiles: [{ path: "a", content: "" }],
					skills: [
						{ name: "s1", path: "/p1", description: "" } as unknown as Skill,
						{ name: "s2", path: "/p2", description: "" } as unknown as Skill,
					],
					prompts: [{ name: "p1" } as unknown as PromptTemplate],
				}),
			],
			manifestDiagnostics: [],
		});
		expect(r.sourceStats[0]).toMatchObject({
			id: "local",
			kind: "local",
			agentsFiles: 1,
			skills: 2,
			prompts: 1,
			failures: [],
		});
	});
});
