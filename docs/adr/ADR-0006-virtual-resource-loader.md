---
title: "Custom VirtualResourceLoader for Multi-Root Resource Composition"
adr: ADR-0006
status: Accepted
date: 2026-05-19
prd: "docs/prd/PRD-002-portable-runtime.md"
decision: "Implement VirtualResourceLoader as a custom pi ResourceLoader; do not fork pi"
---

# ADR-0006: Custom VirtualResourceLoader for Multi-Root Resource Composition

## Status

Accepted

## Date

2026-05-19

## Requirement Source

- **PRD**: `docs/prd/PRD-002-portable-runtime.md`
- **Decision Point**: FR-1 (`VirtualResourceLoader`).

## Context

Pi `0.75.3` discovers resources (`AGENTS.md` chain, skills, prompts, themes, extensions, system-prompt overrides) through a single `ResourceLoader` instance, constructed by default as `DefaultResourceLoader({ cwd, agentDir, settingsManager })`. The default loader reads from one local cwd plus `~/.pi/agent/` only.

The v0.6 goal is multi-root composition across heterogeneous hosts: local cwd, ACP-delegated FS, SSH-reachable host, HTTPS URL. None of those are reachable by `DefaultResourceLoader`.

Pi exposes the right lever: `createAgentSession({ resourceLoader })` accepts a fully custom implementation of the `ResourceLoader` interface. The interface is small:

```ts
interface ResourceLoader {
  getExtensions(): LoadExtensionsResult;
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
  getSystemPrompt(): string | undefined;
  getAppendSystemPrompt(): string[];
  extendResources(paths: ResourceExtensionPaths): void;
  reload(): Promise<void>;
}
```

The question is whether to patch `DefaultResourceLoader` upstream (fork pi) or implement an external composer that satisfies the same interface.

## Decision Drivers

- v0.6 ships within months; a pi fork carries indefinite carrying cost.
- The `ResourceLoader` interface is small and has not changed in the public API surface from `0.69` to `0.75` (verified via CHANGELOG scan and source inspection).
- Pi-acp already adds a translation layer between pi and ACP; adding a resource composition layer fits the same architectural slot.
- A custom `ResourceLoader` is the documented escape hatch — the SDK example in `coding-agent/src/core/sdk.ts:179` shows exactly this pattern.

## Considered Options

### Option 1: Patch pi to support multi-root in `DefaultResourceLoader`

- Good, because every pi consumer benefits.
- Bad, because pi has its own roadmap and a multi-root model may not match the upstream vision.
- Bad, because pi-acp would carry a fork until upstream merges (uncertain timeline).
- Bad, because remote backends (SSH, HTTPS) are unlikely to land in pi proper — they are an ACP-adapter concern.

### Option 2: Subclass `DefaultResourceLoader` and override accessors

- Good, because inherits default behavior for free.
- Bad, because `DefaultResourceLoader` was not designed for subclassing; private fields and final-ish methods make this fragile.
- Bad, because pi could refactor internal state shape without notice, breaking the subclass.

### Option 3: Implement `VirtualResourceLoader` from scratch against the interface (chosen)

- Good, because depends only on the public interface contract.
- Good, because explicit composition logic is auditable in one place (`src/resources/loader.ts`).
- Good, because each `ResourceSource` backend is independently testable.
- Good, because future kinds (`container`, `git-rev`) can be added without touching pi.
- Neutral, because we re-implement local-FS reading via `LocalBackend`. Mitigation: `LocalBackend` can delegate to pi's `loadProjectContextFiles`, `loadSkills`, `loadSkillsFromDir` helpers, which are exported from `@earendil-works/pi-coding-agent`.

## Decision

Chosen option: **"Implement `VirtualResourceLoader` from scratch against pi's public `ResourceLoader` interface"**, because it depends only on documented contract, keeps composition logic auditable in pi-acp, supports remote backends that pi will likely never carry natively, and avoids the long-term cost of a pi fork.

## Consequences

### Positive

- Single source of truth for multi-root composition lives in pi-acp; pi-acp owns the policy.
- New backends (`container`, `git-rev`, future) are local additions, not pi PRs.
- Test surface is bounded — each backend is a unit; the loader is a unit; integration tests verify pi sees them correctly.

### Negative

- Pi's `ResourceLoader` interface may change in a future pi major. Mitigation: pin pi minor; treat interface drift as a deliberate upgrade event with a CHANGELOG-driven migration step.
- `LocalBackend` reproduces some of `DefaultResourceLoader`'s logic for path discovery. Mitigation: delegate to pi's exported helpers (`loadProjectContextFiles`, `loadSkills`) where possible; only re-implement what is composition-specific.

### Neutral

- Pi-acp's bin gains a `src/resources/` subtree. Layout cost is one directory; documented in PRD-002 §9.

## Related

- **PRD**: `docs/prd/PRD-002-portable-runtime.md` (FR-1).
- **Plan**: `docs/architecture/plan-portable-runtime.md` (Phase 1).
- **Pi source**: `@earendil-works/pi-coding-agent@v0.75.3` — `core/resource-loader.ts` (interface definition), `core/sdk.ts:193` (factory accepts custom loader).
- **ADRs**: ADR-0007 (ACP-FS delegation — depends on `VirtualResourceLoader` slot); ADR-0008 (manifest — drives loader configuration).
