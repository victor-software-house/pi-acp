/**
 * ACP `providers/*` method implementations.
 *
 * PRD-002 substrate completion. ACP exposes 3 unstable provider-config
 * methods (list, set, disable) gated by `agentCapabilities.providers = {}`.
 *
 * Pi's `ModelRegistry` exposes `registerProvider` + `unregisterProvider`
 * (dynamic, per-process). There is NO public writer for pi's `models.json`,
 * so provider config mutations made through these methods affect only the
 * currently-live ModelRegistry instances on this pi-acp process. New
 * sessions created after this process restarts will see pristine state
 * sourced from auth.json + models.json on disk. Documented limitation.
 *
 * `unstable_disableProvider` has no native pi analog (pi has only
 * `unregister`, which is destructive). We layer a soft-disable on top: the
 * provider's id is added to a pi-acp-side `Set<string>` and ALSO
 * unregistered from the live ModelRegistry; `listProviders` reports
 * `current: null` for any id in the disabled set, matching the ACP spec
 * ("Null or omitted means provider is disabled").
 */

import type {
	DisableProvidersRequest,
	DisableProvidersResponse,
	ListProvidersResponse,
	LlmProtocol,
	ProviderInfo,
	SetProvidersRequest,
	SetProvidersResponse,
} from "@agentclientprotocol/sdk";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Map an ACP `LlmProtocol` to a pi `Api` identifier. Used when
 * `unstable_setProvider` injects a provider whose `apiType` is one of the
 * spec's enumerated protocols. Unknown protocols pass through verbatim
 * (LlmProtocol is `KnownProtocol | string`).
 */
function acpProtocolToPiApi(protocol: LlmProtocol): string {
	switch (protocol) {
		case "anthropic":
			return "anthropic-messages";
		case "openai":
			return "openai-responses";
		case "azure":
			return "azure-openai-responses";
		case "vertex":
			return "google-vertex";
		case "bedrock":
			return "bedrock-converse-stream";
		default:
			return protocol;
	}
}

/**
 * Reverse map: pi `Api` → ACP `LlmProtocol`. Used by `listProviders` to
 * describe each pi-known model's transport. Falls back to the raw `api`
 * string when no canonical bucket matches.
 */
function piApiToAcpProtocol(api: string): LlmProtocol {
	if (api.startsWith("anthropic")) return "anthropic";
	if (api.startsWith("openai")) return "openai";
	if (api.startsWith("azure")) return "azure";
	if (api.includes("vertex")) return "vertex";
	if (api.startsWith("bedrock")) return "bedrock";
	if (api.startsWith("google")) return "vertex";
	return api;
}

export interface ProviderHandlersDeps {
	/** Returns the set of live ModelRegistry instances to apply mutations to. */
	registries: () => Iterable<ModelRegistry>;
	/** Shared disabled-set; mutated by disableProvider. */
	disabled: Set<string>;
}

export function buildListProvidersResponse(deps: ProviderHandlersDeps): ListProvidersResponse {
	// Pick the first live ModelRegistry for the read view. All live
	// registries share the same AuthStorage + models.json snapshot, so any
	// one is representative. If no session is live, return empty providers
	// (no models loaded, nothing to enumerate).
	const first = firstRegistry(deps.registries());
	if (first === undefined) {
		return { providers: [] };
	}

	const byProvider = new Map<string, { baseUrls: Set<string>; protocols: Set<LlmProtocol> }>();
	for (const model of first.getAll()) {
		const entry = byProvider.get(model.provider) ?? {
			baseUrls: new Set<string>(),
			protocols: new Set<LlmProtocol>(),
		};
		entry.baseUrls.add(model.baseUrl);
		entry.protocols.add(piApiToAcpProtocol(model.api));
		byProvider.set(model.provider, entry);
	}

	const providers: ProviderInfo[] = Array.from(byProvider.entries()).map(([id, entry]) => {
		const supported = Array.from(entry.protocols);
		const primaryBaseUrl = Array.from(entry.baseUrls)[0] ?? "";
		const primaryProtocol = supported[0] ?? ("openai" as LlmProtocol);
		const disabled = deps.disabled.has(id);
		const info: ProviderInfo = {
			id,
			supported,
			required: false,
			current: disabled ? null : { apiType: primaryProtocol, baseUrl: primaryBaseUrl },
		};
		return info;
	});

	return { providers };
}

export function applySetProvider(
	deps: ProviderHandlersDeps,
	params: SetProvidersRequest,
): SetProvidersResponse {
	const config = {
		baseUrl: params.baseUrl,
		api: acpProtocolToPiApi(params.apiType),
		...(params.headers !== undefined ? { headers: params.headers } : {}),
	};
	for (const reg of deps.registries()) {
		reg.registerProvider(params.id, config);
	}
	// Setting a provider implicitly re-enables it if previously disabled.
	deps.disabled.delete(params.id);
	return {};
}

export function applyDisableProvider(
	deps: ProviderHandlersDeps,
	params: DisableProvidersRequest,
): DisableProvidersResponse {
	deps.disabled.add(params.id);
	for (const reg of deps.registries()) {
		try {
			reg.unregisterProvider(params.id);
		} catch {
			// best-effort — provider may have already been unregistered
		}
	}
	return {};
}

function firstRegistry(it: Iterable<ModelRegistry>): ModelRegistry | undefined {
	for (const reg of it) return reg;
	return undefined;
}
