/**
 * providers unit tests for buildListProvidersResponse + applySetProvider
 * + applyDisableProvider. Stubs the pi ModelRegistry surface needed by
 * these handlers without spinning up an actual pi session.
 */

import { describe, expect, test } from "bun:test";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	applyDisableProvider,
	applySetProvider,
	buildListProvidersResponse,
} from "@pi-acp/acp/providers";

interface StubModel {
	id: string;
	provider: string;
	api: string;
	baseUrl: string;
}

interface StubModelRegistryRec {
	registered: Array<{ name: string; config: unknown }>;
	unregistered: string[];
}

function makeStubRegistry(models: StubModel[]): {
	reg: ModelRegistry;
	rec: StubModelRegistryRec;
} {
	const rec: StubModelRegistryRec = { registered: [], unregistered: [] };
	const reg = {
		getAll: () => models,
		registerProvider: (name: string, config: unknown) => {
			rec.registered.push({ name, config });
		},
		unregisterProvider: (name: string) => {
			rec.unregistered.push(name);
		},
	} as unknown as ModelRegistry;
	return { reg, rec };
}

describe("buildListProvidersResponse", () => {
	test("returns empty providers when no registries are live", () => {
		const r = buildListProvidersResponse({
			registries: () => [],
			disabled: new Set(),
		});
		expect(r.providers).toEqual([]);
	});

	test("groups models by provider and emits one ProviderInfo each", () => {
		const { reg } = makeStubRegistry([
			{
				id: "claude-opus-4",
				provider: "anthropic",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
			},
			{
				id: "claude-sonnet-4",
				provider: "anthropic",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
			},
			{
				id: "gpt-4o",
				provider: "openai",
				api: "openai-responses",
				baseUrl: "https://api.openai.com",
			},
		]);
		const r = buildListProvidersResponse({
			registries: () => [reg],
			disabled: new Set(),
		});
		expect(r.providers).toHaveLength(2);
		const anthropic = r.providers.find((p) => p.id === "anthropic");
		expect(anthropic?.supported).toContain("anthropic");
		expect(anthropic?.required).toBe(false);
		expect(anthropic?.current?.apiType).toBe("anthropic");
		expect(anthropic?.current?.baseUrl).toBe("https://api.anthropic.com");
	});

	test("disabled providers report current: null", () => {
		const { reg } = makeStubRegistry([
			{
				id: "claude-opus-4",
				provider: "anthropic",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
			},
		]);
		const r = buildListProvidersResponse({
			registries: () => [reg],
			disabled: new Set(["anthropic"]),
		});
		expect(r.providers[0]?.current).toBeNull();
	});

	test("api type mapping: bedrock + vertex + azure routed to correct LlmProtocol", () => {
		const { reg } = makeStubRegistry([
			{ id: "m1", provider: "amazon-bedrock", api: "bedrock-converse-stream", baseUrl: "u" },
			{ id: "m2", provider: "google-vertex", api: "google-vertex", baseUrl: "u" },
			{
				id: "m3",
				provider: "azure-openai-responses",
				api: "azure-openai-responses",
				baseUrl: "u",
			},
		]);
		const r = buildListProvidersResponse({
			registries: () => [reg],
			disabled: new Set(),
		});
		expect(r.providers.find((p) => p.id === "amazon-bedrock")?.supported).toContain("bedrock");
		expect(r.providers.find((p) => p.id === "google-vertex")?.supported).toContain("vertex");
		expect(r.providers.find((p) => p.id === "azure-openai-responses")?.supported).toContain(
			"azure",
		);
	});
});

describe("applySetProvider", () => {
	test("calls registerProvider on every live registry with mapped api", () => {
		const { reg: a, rec: aRec } = makeStubRegistry([]);
		const { reg: b, rec: bRec } = makeStubRegistry([]);
		const disabled = new Set<string>();
		applySetProvider(
			{ registries: () => [a, b], disabled },
			{
				id: "openai",
				apiType: "openai",
				baseUrl: "https://api.openai.com",
				headers: { Authorization: "Bearer xxx" },
			},
		);
		expect(aRec.registered).toHaveLength(1);
		expect(bRec.registered).toHaveLength(1);
		expect(aRec.registered[0]?.name).toBe("openai");
		expect((aRec.registered[0]?.config as { api: string }).api).toBe("openai-responses");
		expect((aRec.registered[0]?.config as { headers: Record<string, string> }).headers).toEqual({
			Authorization: "Bearer xxx",
		});
	});

	test("re-enables previously-disabled provider", () => {
		const { reg } = makeStubRegistry([]);
		const disabled = new Set<string>(["openai"]);
		applySetProvider(
			{ registries: () => [reg], disabled },
			{ id: "openai", apiType: "openai", baseUrl: "https://api.openai.com" },
		);
		expect(disabled.has("openai")).toBe(false);
	});
});

describe("applyDisableProvider", () => {
	test("adds id to disabled set + calls unregisterProvider on every registry", () => {
		const { reg: a, rec: aRec } = makeStubRegistry([]);
		const { reg: b, rec: bRec } = makeStubRegistry([]);
		const disabled = new Set<string>();
		applyDisableProvider({ registries: () => [a, b], disabled }, { id: "anthropic" });
		expect(disabled.has("anthropic")).toBe(true);
		expect(aRec.unregistered).toEqual(["anthropic"]);
		expect(bRec.unregistered).toEqual(["anthropic"]);
	});

	test("swallows unregister errors (provider already gone)", () => {
		const reg = {
			getAll: () => [],
			registerProvider: () => {},
			unregisterProvider: () => {
				throw new Error("not found");
			},
		} as unknown as ModelRegistry;
		const disabled = new Set<string>();
		expect(() =>
			applyDisableProvider({ registries: () => [reg], disabled }, { id: "x" }),
		).not.toThrow();
		expect(disabled.has("x")).toBe(true);
	});
});
