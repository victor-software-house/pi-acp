/**
 * HttpBackend tests use an injected `fetchImpl` stub. We never hit the real
 * network — a real HTTPS fixture server would require self-signed certs and
 * a TLS-relaxed fetch, which Bun's `fetch` doesn't expose cleanly. The
 * stub mirrors the same surface (`fetch(url, init?) => Promise<Response>`)
 * so the production path stays untouched in tests.
 */

import { describe, expect, test } from "bun:test";

import { HttpBackend } from "@pi-acp/resources/sources/http";

interface StubCall {
	url: string;
	signal?: AbortSignal;
}

interface StubOptions {
	status?: number;
	statusText?: string;
	body?: string;
	throwError?: Error;
	delayMs?: number;
}

function makeFetchStub(responsesByUrl: Record<string, StubOptions | StubOptions[]>): {
	fetch: typeof fetch;
	calls: StubCall[];
} {
	const calls: StubCall[] = [];
	const cursors = new Map<string, number>();

	const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
		const call: StubCall = { url };
		if (init?.signal) call.signal = init.signal;
		calls.push(call);

		const entry = responsesByUrl[url];
		if (entry === undefined) {
			return new Response("not found", { status: 404, statusText: "Not Found" });
		}
		const opts = Array.isArray(entry)
			? (entry[Math.min(cursors.get(url) ?? 0, entry.length - 1)] ?? {})
			: entry;
		cursors.set(url, (cursors.get(url) ?? 0) + 1);

		if (opts.delayMs !== undefined && opts.delayMs > 0) {
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(resolve, opts.delayMs);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(t);
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		}
		if (opts.throwError !== undefined) throw opts.throwError;
		return new Response(opts.body ?? "", {
			status: opts.status ?? 200,
			statusText: opts.statusText ?? "OK",
		});
	}) as typeof fetch;

	return { fetch: fetchImpl, calls };
}

describe("HttpBackend constructor", () => {
	test("rejects non-https baseUrl", () => {
		expect(
			() =>
				new HttpBackend({
					id: "h",
					baseUrl: "http://example.com",
				}),
		).toThrow(/must use https:\/\//);
	});

	test("rejects ftp baseUrl", () => {
		expect(
			() =>
				new HttpBackend({
					id: "h",
					baseUrl: "ftp://example.com",
				}),
		).toThrow(/must use https:\/\//);
	});

	test("accepts https baseUrl and strips trailing slash", async () => {
		const stub = makeFetchStub({
			"https://example.com/AGENTS.md": { body: "hi" },
		});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com/",
			paths: { agentsFiles: ["AGENTS.md"] },
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		expect(backend.getAgentsFiles()[0]?.path).toBe("https://example.com/AGENTS.md");
	});
});

describe("HttpBackend.reload + getAgentsFiles", () => {
	test("returns empty list when no agentsFiles declared", async () => {
		const stub = makeFetchStub({});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com",
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		expect(backend.getAgentsFiles()).toEqual([]);
		expect(backend.getSkills().diagnostics).toEqual([]);
		expect(stub.calls).toHaveLength(0);
	});

	test("fetches each declared agentsFile and qualifies path with baseUrl", async () => {
		const stub = makeFetchStub({
			"https://raw.githubusercontent.com/x/y/main/AGENTS.md": { body: "Hello" },
			"https://raw.githubusercontent.com/x/y/main/SECURITY.md": { body: "secret" },
		});
		const backend = new HttpBackend({
			id: "gh",
			baseUrl: "https://raw.githubusercontent.com/x/y/main",
			paths: { agentsFiles: ["AGENTS.md", "SECURITY.md"] },
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		const files = backend.getAgentsFiles();
		expect(files).toHaveLength(2);
		expect(files[0]?.path).toBe("https://raw.githubusercontent.com/x/y/main/AGENTS.md");
		expect(files[0]?.content).toBe("Hello");
		expect(files[1]?.path).toBe("https://raw.githubusercontent.com/x/y/main/SECURITY.md");
		expect(files[1]?.content).toBe("secret");
	});

	test("dedupes leading slashes in declared paths", async () => {
		const stub = makeFetchStub({
			"https://example.com/AGENTS.md": { body: "hi" },
		});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com",
			paths: { agentsFiles: ["/AGENTS.md"] },
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		expect(stub.calls[0]?.url).toBe("https://example.com/AGENTS.md");
	});

	test("surfaces 4xx as warning diagnostic without throwing", async () => {
		const stub = makeFetchStub({
			"https://example.com/missing": { status: 404, statusText: "Not Found" },
			"https://example.com/present": { body: "hi" },
		});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com",
			paths: { agentsFiles: ["missing", "present"] },
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		const files = backend.getAgentsFiles();
		expect(files).toHaveLength(1);
		expect(files[0]?.path).toBe("https://example.com/present");
		const diagnostics = backend.getSkills().diagnostics;
		expect(
			diagnostics.some((d) => d.message.includes("missing") && d.message.includes("HTTP 404")),
		).toBe(true);
	});

	test("surfaces 5xx as warning diagnostic without throwing", async () => {
		const stub = makeFetchStub({
			"https://example.com/flaky": { status: 503, statusText: "Service Unavailable" },
		});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com",
			paths: { agentsFiles: ["flaky"] },
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		expect(backend.getAgentsFiles()).toEqual([]);
		const diagnostics = backend.getSkills().diagnostics;
		expect(
			diagnostics.some((d) => d.message.includes("flaky") && d.message.includes("HTTP 503")),
		).toBe(true);
	});

	test("surfaces fetch errors as warning diagnostic", async () => {
		const stub = makeFetchStub({
			"https://example.com/broken": { throwError: new TypeError("ENETUNREACH") },
		});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com",
			paths: { agentsFiles: ["broken"] },
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		expect(backend.getAgentsFiles()).toEqual([]);
		const diagnostics = backend.getSkills().diagnostics;
		expect(
			diagnostics.some((d) => d.message.includes("broken") && d.message.includes("ENETUNREACH")),
		).toBe(true);
	});

	test("times out a hanging fetch and surfaces a diagnostic", async () => {
		const stub = makeFetchStub({
			"https://example.com/slow": { delayMs: 1000 },
		});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com",
			paths: { agentsFiles: ["slow"] },
			timeoutMs: 25,
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		expect(backend.getAgentsFiles()).toEqual([]);
		const diagnostics = backend.getSkills().diagnostics;
		expect(
			diagnostics.some((d) => d.message.includes("slow") && d.message.includes("timed out")),
		).toBe(true);
	});
});

describe("HttpBackend cache (cacheTtlSeconds)", () => {
	test("cache hit on second reload within TTL — no extra fetch call", async () => {
		const stub = makeFetchStub({
			"https://example.com/AGENTS.md": [{ body: "first" }, { body: "second" }],
		});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com",
			paths: { agentsFiles: ["AGENTS.md"] },
			cacheTtlSeconds: 60,
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		await backend.reload();
		expect(stub.calls).toHaveLength(1);
		expect(backend.getAgentsFiles()[0]?.content).toBe("first");
	});

	test("cache miss when ttl=0 — every reload refetches", async () => {
		const stub = makeFetchStub({
			"https://example.com/AGENTS.md": [{ body: "first" }, { body: "second" }],
		});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com",
			paths: { agentsFiles: ["AGENTS.md"] },
			cacheTtlSeconds: 0,
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		await backend.reload();
		expect(stub.calls).toHaveLength(2);
		expect(backend.getAgentsFiles()[0]?.content).toBe("second");
	});
});

describe("HttpBackend unsupported kinds", () => {
	test("emits diagnostics when paths.skills / .prompts / .extensions are declared", async () => {
		const stub = makeFetchStub({});
		const backend = new HttpBackend({
			id: "h",
			baseUrl: "https://example.com",
			paths: { skills: "/skills", prompts: "/prompts", extensions: "/exts" },
			fetchImpl: stub.fetch,
		});
		await backend.reload();
		const messages = backend
			.getSkills()
			.diagnostics.map((d) => d.message)
			.join("\n");
		expect(messages).toContain("skills discovery over HTTP not yet implemented");
		expect(messages).toContain("prompts discovery over HTTP not yet implemented");
		expect(messages).toContain("extensions discovery over HTTP not yet implemented");
		expect(backend.getSkills().skills).toEqual([]);
		expect(backend.getPrompts().prompts).toEqual([]);
	});
});

describe("HttpBackend trivial getters", () => {
	test("getSystemPrompt / getAppendSystemPrompt return empty defaults", () => {
		const backend = new HttpBackend({ id: "x", baseUrl: "https://example.com" });
		expect(backend.getSystemPrompt()).toBeUndefined();
		expect(backend.getAppendSystemPrompt()).toEqual([]);
	});
});
