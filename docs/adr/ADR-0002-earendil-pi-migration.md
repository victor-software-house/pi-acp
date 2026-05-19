---
title: "Migrate Pi Dependencies from @mariozechner/* to @earendil-works/*"
adr: ADR-0002
status: Accepted
date: 2026-05-18
prd: "docs/prd/PRD-001-acp-v013-zed-alignment.md"
decision: "Replace all three pi deps at scope and bump 0.62 → 0.75"
---

# ADR-0002: Migrate Pi Dependencies from @mariozechner/* to @earendil-works/*

## Status

Accepted

## Date

2026-05-18

## Requirement Source

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md`
- **Decision Point**: FR-2 (Earendil pi runtime migration).

## Context

Pi was originally authored under the `@mariozechner` npm scope (Mario Zechner, the original author). In late 2025 / early 2026 the project moved to the [earendil-works](https://github.com/earendil-works) GitHub organization, and packages were re-scoped to `@earendil-works/*`. The `@mariozechner/*` packages are no longer the publication target — the canonical source is `@earendil-works/*`, and the gap is widening with every pi release.

Current state of pi-acp's dependencies:

| Old scope | Used in pi-acp | New scope | Latest |
|--|--|--|--|
| `@mariozechner/pi-coding-agent` | `^0.62.0` | `@earendil-works/pi-coding-agent` | `0.75.3` |
| `@mariozechner/pi-agent-core` | (transitive via above) | `@earendil-works/pi-agent-core` | `0.75.3` |
| `@mariozechner/pi-ai` | (transitive via above) | `@earendil-works/pi-ai` | `0.75.3` |

Pi-acp imports types from all three:

- `@mariozechner/pi-coding-agent`: `AgentSession`, `CreateAgentSessionResult`, `createAgentSession`, `SessionManager`.
- `@mariozechner/pi-agent-core`: `AgentMessage` (used in `src/acp/translate/pi-messages.ts`).
- `@mariozechner/pi-ai`: `AssistantMessage`, `ToolResultMessage`, `UserMessage` (used in translate layer).

The gap is **13 minor versions** (`0.62 → 0.75`), accumulated over the period when pi moved orgs. The pi monorepo at `earendil-works/pi` is the live development tree; no further development happens on `@mariozechner/*`.

## Decision Drivers

- `@mariozechner/*` is unmaintained going forward. Any pi bug fix lands on `@earendil-works/*` only.
- Pi `0.75.3` ships a stable SDK surface (`docs/sdk.md` documents `createAgentSession`, `SessionManager`, `ModelRegistry`, `AuthStorage`) that pi-acp depends on.
- Pi-acp's PRD-001 cannot deliver Zed-correct tool rendering (FR-4..FR-6) without access to pi event-shape changes that landed between `0.62` and `0.75`.
- The fork's own legacy `PLAN.md` already records pi runtime migration as a planned work item — this ADR makes the decision permanent.
- The published-package rename is reversible in theory (npm allows re-scoping) but irreversible in practice — pi's org migration is settled, and no plan to publish to `@mariozechner/*` exists.

## Considered Options

### Option 1: Stay on `@mariozechner/* @ 0.62.0`

- Good, because no migration work required immediately.
- Bad, because pi bug fixes never reach pi-acp.
- Bad, because pi-acp falls behind ACP conformance requirements that depend on newer pi events.
- Bad, because any future contributor will face the same migration eventually, with a wider gap.
- Bad, because `@mariozechner/*` is effectively abandoned upstream.

### Option 2: Pin to `@earendil-works/* @ 0.75.3` exactly

- Good, because predictable upgrade path — each future minor is a deliberate bump.
- Bad, because patch releases (`0.75.4`, `0.75.5`) require a manual bump.

### Option 3: Range-pin to `@earendil-works/* @ ^0.75.3` (chosen)

- Good, because picks up patch releases automatically.
- Good, because the `^` range still pins the major (pre-1.0 pi treats minor as breaking, so `^0.75.x` only floats patch).
- Good, because matches the existing dependency-management style in the fork's `package.json`.
- Neutral, because requires periodic minor-bump PRs to track pi development.

## Decision

Chosen option: **"Range-pin to `@earendil-works/* @ ^0.75.3`"**, because it matches the fork's existing dep style, picks up patch fixes automatically, and pre-1.0 caret semantics already gate minor changes behind explicit bumps.

## Consequences

### Positive

- pi-acp picks up the 13 minors of pi development missed since `0.62`, including any fixes the translate layer relies on.
- Future pi releases reach pi-acp by changing one version in `package.json`.
- Aligns pi-acp with the live development tree at `earendil-works/pi`.

### Negative

- TypeScript breakage is likely. Pi has shipped 13 minor versions; event types, message shapes, and tool-kind enums may have changed. Mitigation: PRD-001 phases this migration first (Phase 1) so type errors are isolated from the SDK bump and the conformance work. Component tests will catch wire-format regressions.
- Pi-acp's `engines.node` is `>= 20`; pi `0.75.3` requires `>= 24`. v0.5 hard-pins pi-acp's engine to `>= 24` to match. Users on Node `< 24` cannot install v0.5+; they must upgrade Node or stay on v0.4.x.

### Neutral

- The migration is mechanical for imports (sed-replace the scope) but may require translate-layer adjustments for event shape changes.
- pi peer-dep declarations in pi-acp's `package.json` (if added later for pi-acp-as-extension scenarios) should consistently use the `@earendil-works/*` scope going forward.

## Related

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md` (FR-2)
- **Plan**: `docs/architecture/plan-acp-v013-zed-alignment.md` (Phase 1)
- **Pi source**: `earendil-works/pi@v0.75.3` (packages: `pi-coding-agent`, `pi-agent-core`, `pi-ai`).
- **ADRs**: ADR-0001 (Standalone server — sets the stage for this migration; pi-acp is an SDK consumer, so SDK scope matters).
