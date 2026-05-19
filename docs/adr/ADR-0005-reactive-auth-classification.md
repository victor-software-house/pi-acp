---
title: "Reactive Auth Classification via Pi State, Not Env-Var Sniffing"
adr: ADR-0005
status: Accepted
date: 2026-05-18
prd: "docs/prd/PRD-001-acp-v013-zed-alignment.md"
decision: "Spawn pi, probe state + models, classify errors; delete env-sniffing module"
---

# ADR-0005: Reactive Auth Classification via Pi State, Not Env-Var Sniffing

## Status

Accepted

## Date

2026-05-18

## Requirement Source

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md`
- **Decision Point**: FR-4 (Reactive auth classification).

## Context

The fork's current `newSession` flow runs a **proactive** auth gate before spawning pi:

```ts
// src/acp/agent.ts (current, v0.4.0)
if (!hasPiAuthConfigured()) {
  throw RequestError.authRequired(
    { authMethods: buildAuthMethods() },
    "Configure an API key or log in with an OAuth provider.",
  );
}
```

`hasPiAuthConfigured()` lives in `src/pi-auth/status.ts` and checks three sources:

1. `~/.pi/agent/auth.json` exists and is non-empty.
2. `~/.pi/agent/models.json` has any provider with an `apiKey` field.
3. A hardcoded list of 22 provider env vars is set (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `COPILOT_GITHUB_TOKEN`, etc.).

The motivation, per a code comment: "pi exits immediately in `--mode rpc` if no model is available, so we must detect that situation without spawning pi." Functional, but it carries durable problems:

- **The env-var list goes stale.** Every time pi adds a provider, pi-acp must add the new env-var name. Pi-acp lives outside pi's release cycle; the list drifts.
- **It does not reflect pi's actual model state.** A user can have `OPENAI_API_KEY` set but pi configured to use a different provider; the gate passes spuriously. Or pi can have a configured provider whose env var isn't in the list; the gate fails spuriously.
- **Three sources, one truth.** The three checks express the same question ("does pi have at least one usable model?") in three different vocabularies that all need to stay in sync with pi's actual model-selection logic.

svkozak `74010be` ("fix: classify auth from pi runtime") replaces the proactive gate with a reactive pattern:

1. Spawn the pi session unconditionally.
2. Call `session.proc.state()` and `session.proc.getAvailableModels()` in parallel.
3. If either rejects, classify the error via `maybeAuthRequiredError(err)`:
   - Auth-related rejection → clean up the half-created session, throw `RequestError.authRequired`.
   - Non-auth rejection → clean up, throw `RequestError.internalError` with the original message.
4. If both resolve but `availableModels.models.length === 0` → clean up, throw `RequestError.authRequired` (pi spawned but has no usable model — the same condition the env sniffing was trying to detect).
5. Otherwise, proceed.

The cleanup helper (`cleanupFailedNewSession`) removes the session from the in-memory map, deletes the session file from disk if it was created, and removes the entry from the session store — preventing orphan session state from accumulating when newSession fails after partial setup.

The fork already has the `detectAuthError` / `maybeAuthRequiredError` classifier in `src/acp/auth-required.ts`. It is used by `loadSession` but bypassed by `newSession`'s proactive gate.

## Decision Drivers

- Pi's model availability is the only authoritative signal for "can this session do anything"; reading env vars approximates it from outside.
- Pi-acp lives outside pi's release cycle; behavior that depends on pi's internal provider list creates a maintenance burden every time pi ships.
- The fork already has the classifier; using it consistently is the small change.
- Half-created sessions on auth failure leak state to `~/.pi/agent/sessions/` and to the in-memory `SessionManager` — the proactive gate hides this leak by exiting early, but the leak still exists on every other code path that can fail mid-creation.

## Considered Options

### Option 1: Keep proactive env-sniffing (`hasPiAuthConfigured`)

- Good, because no implementation change needed.
- Bad, because the env-var list goes stale every time pi adds a provider.
- Bad, because does not reflect pi's actual configuration.
- Bad, because three independent code paths (auth.json, models.json, env vars) attempt to answer one question.

### Option 2: Extend env-sniffing to read pi's settings.json

- Good, because removes the hardcoded env-var list.
- Bad, because pi's settings.json schema is an internal contract; pi-acp would be coupled to pi's config layout rather than pi's API.
- Bad, because still proactive — still tries to predict pi's behavior without asking pi.

### Option 3: Reactive classification via pi state (chosen)

- Good, because pi's state is the source of truth.
- Good, because pi-acp stays decoupled from pi's provider list.
- Good, because the cleanup-on-failure pattern catches half-created session leaks.
- Good, because the classifier is reused across `newSession` and `loadSession` — fewer auth code paths.
- Neutral, because adds a small latency cost (spawning pi to find out it has no auth). In practice this is one process spawn + two RPC calls; the user-perceived cost is dwarfed by Zed's own session-setup time.
- Bad, because pi must be installed and spawnable just to detect "no auth." Mitigation: pi-acp already requires pi to be installed (it's the agent runtime); a missing pi binary errors cleanly via `ENOENT`.

## Decision

Chosen option: **"Reactive classification via pi state"**, ported from svkozak `74010be`, adapted to the fork's existing classifier in `src/acp/auth-required.ts`. The `hasPiAuthConfigured` function and `src/pi-auth/status.ts` module are deleted once unreferenced.

## Consequences

### Positive

- Auth state derives from pi's actual model availability. Adding a provider to pi's settings is enough — no pi-acp change required.
- The half-created-session leak path is closed via `cleanupFailedNewSession`.
- `newSession` and `loadSession` share one auth-detection mechanism.
- Removes ~80 LOC of env-var maintenance and JSON-file probing.

### Negative

- One process spawn per attempted `newSession` against unauthenticated pi. Acceptable: this is the user's first action; latency is masked by Zed's session-creation UI.
- The `cleanupFailedNewSession` helper must handle partial state correctly (session file may or may not exist; in-memory map entry always exists). Mitigation: helper is small, easily tested.

### Neutral

- Pi's error shape for "no models available" must be classifiable. The fork's `detectAuthError` already covers `loadSession` errors; verify coverage extends to the `getAvailableModels` rejection shape in pi `0.75.3` during implementation.
- A future pi version that exposes a synchronous "is auth configured" probe could swap the implementation back to proactive without changing the public contract — `RequestError.authRequired` with the same `authMethods` payload either way. This ADR does not preclude that refactor.

## Related

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md` (FR-4).
- **Plan**: `docs/architecture/plan-acp-v013-zed-alignment.md` (Phase 3).
- **Source pattern**: `svkozak/pi-acp@74010be` — commit message "fix: classify auth from pi runtime".
- **Existing classifier**: `src/acp/auth-required.ts` (fork already has `detectAuthError`, `maybeAuthRequiredError`).
- **Module to delete**: `src/pi-auth/status.ts` (env-sniffing).
- **ADRs**: ADR-0002 (Earendil migration — pi 0.75 is the runtime against which error shapes are classified).
