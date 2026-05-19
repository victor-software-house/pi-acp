---
title: "Drop unstable_ Prefix from session/close and session/resume"
adr: ADR-0003
status: Accepted
date: 2026-05-18
prd: "docs/prd/PRD-001-acp-v013-zed-alignment.md"
decision: "Rename close/resume; verify fork status against v0.22.1"
---

# ADR-0003: Drop unstable_ Prefix from session/close and session/resume

## Status

Accepted

## Date

2026-05-18

## Requirement Source

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md`
- **Decision Point**: FR-3 (Stabilize session/close, session/resume, session/fork).

## Context

ACP method stability is tracked per-method, not protocol-wide. Methods graduate through three states:

1. **Unstable** — namespaced `unstable_<methodName>` in the SDK. Wire-incompatible changes may land in any release.
2. **Preview** — graduated past unstable; rename to stable form. ACP RFD process treats this as "API stable, semantics may still tighten."
3. **Stable** — final form. Wire-compatible across the major protocol version.

`session/close`, `session/resume`, and `session/list` graduated to **Preview** in ACP `v0.11.7` ([RFD #969, #970](https://github.com/agentclientprotocol/agent-client-protocol/pulls?q=is%3Apr+969+970)). They graduated to **Stable** in ACP `v0.12.2` ("Stabilize session/close", "Stabilize session/resume").

The TypeScript SDK followed: `@agentclientprotocol/sdk@v0.20.0` ("Stabilize closeSession and resumeSession") removed the `unstable_` prefix from the method-handler signatures in `Agent` interface.

`session/fork` is also exposed by pi-acp via `unstable_forkSession`. Its stabilization status:

- The fork-session capability is advertised in the fork's `sessionCapabilities` block alongside `list`, `close`, `resume`.
- The latest ACP schema (`v0.13.2`) and TS SDK (`v0.22.1`) — to be verified during implementation — should determine whether `forkSession` is stable or still preview.

The fork is pinned at SDK `0.16.1`, before the stabilization. It still declares handlers `unstable_resumeSession`, `unstable_forkSession`, `unstable_closeSession`. Bumping the SDK to `0.22.1` (FR-1) breaks compilation unless these handlers are renamed.

## Decision Drivers

- SDK bump to `0.22.1` is required (PRD FR-1) and forces the rename anyway.
- Stable method names are the only ones documented in the spec going forward.
- Clients written against ACP `>= v0.12.2` call the stable names; clients written against older ACP cannot reach pi-acp v0.5 anyway (pi-acp negotiates `protocolVersion: 1` against `v0.13.x` schema).
- The fork's own component tests (`test/component/session-lifecycle.test.ts`, `test/component/session-replay.test.ts`) reference these handlers and need to be updated in lockstep.

## Considered Options

### Option 1: Keep `unstable_*` handlers, pin SDK at `0.16.1` forever

- Bad, because SDK `0.16.1` lacks v0.13.x schema, critical transport bugfixes (`v0.19.1`, `v0.19.2`, `v0.21.1`, `v0.22.1`), and stable-method renames.
- Bad, because pi-acp would diverge from the spec rather than converge.
- Bad, because every dependent piece of work (FR-4..FR-8) assumes a current SDK.

### Option 2: Bump SDK but keep `unstable_*` aliases

- Good, because no behavior change for any client still calling `unstable_resumeSession` etc.
- Bad, because the SDK no longer exposes `unstable_*` types — re-declaring them inside pi-acp is fork-and-maintain churn.
- Bad, because dual surface adds confusion: which form should new clients call?
- Bad, because the ACP RFD process explicitly designed the rename as the migration path; supporting both subverts that.

### Option 3: Bump SDK, rename handlers to stable form (chosen)

- Good, because matches the SDK shape post-`v0.20.0`.
- Good, because matches the schema-`v0.12.2`+ wire format that any current ACP client speaks.
- Good, because Zed (the primary consumer) uses the SDK and gets the rename automatically.
- Bad, because consumers that hardcoded the `unstable_*` names break. Mitigation: pi-acp v0.5.0 is a minor bump; consumers should read the CHANGELOG. There is no known consumer outside Zed that uses pi-acp's `unstable_*` surface directly.

## Decision

Chosen option: **"Bump SDK, rename handlers to stable form"**, because the rename is the spec's documented migration path, the SDK no longer exposes the unstable types, and clients calling the stable form are the only forward-compatible callers.

## Consequences

### Positive

- Pi-acp's session lifecycle surface aligns with the stable spec.
- `Agent` interface implementation matches the SDK's published shape — no fork-and-maintain of type stubs.
- Future ACP stabilizations (e.g., `session/delete`, `providers/*`) can graduate via the same pattern without precedent ambiguity.

### Negative

- Any external code that hardcoded `unstable_resumeSession` etc. on the wire (rather than going through the SDK) breaks. Mitigation: document in `CHANGELOG.md`; no known external caller.
- Component tests must be updated in the same PR — split scope is risky here. Mitigation: PRD-001 Phase 2 owns this; it's a single focused PR.

### Neutral

- `unstable_forkSession` status must be verified against `v0.22.1`. If `forkSession` is still preview, it stays prefixed; if stable, it joins close/resume in the rename. The implementation phase resolves this.
- `session/list` capability remains advertised; the method is invoked via stable name already in the fork.

## Related

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md` (FR-3)
- **Plan**: `docs/architecture/plan-acp-v013-zed-alignment.md` (Phase 2)
- **Spec source**: `agentclientprotocol/agent-client-protocol` CHANGELOG entries `v0.11.7`, `v0.12.2`; TS SDK CHANGELOG `v0.20.0`.
- **ADRs**: ADR-0002 (depends-on; SDK bump and pi migration must precede this rename to keep typecheck green).
