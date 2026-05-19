---
title: "pi-acp v0.5: ACP v0.13 + Earendil pi Alignment"
prd: "PRD-001-acp-v013-zed-alignment"
date: 2026-05-18
author: "Victor Araujo"
status: Shipped
shipped_pr: "https://github.com/victor-software-house/pi-acp/pull/2"
---

# Plan: pi-acp v0.5 — ACP v0.13 + Earendil pi Alignment

## Source

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md`
- **Date**: 2026-05-18
- **Author**: Victor Araujo

## Architecture Overview

pi-acp is a standalone Node/Bun bin that speaks ACP (JSON-RPC over stdio) on one side and embeds pi's coding-agent SDK on the other. The bin's job is bidirectional translation: ACP requests in → pi SDK calls → pi events out → ACP `session/update` notifications.

This plan closes three drifts on the pre-existing v0.4.0 architecture: a stale ACP SDK, a frozen `@mariozechner/*` pi runtime, and a brittle proactive auth gate. It also lands runtime hardening (stdout discipline, `connection.closed` shutdown), salvages pi-event status surfacing from svkozak, and standardizes the doc layout on pi-specdocs.

The plan **does not** change the v0.3.0 conformance surface (per-tool formatter dispatch, terminal-content lifecycle, `_meta.piAcp.toolName`, model alias resolution, prompt queueing, exhaustive event handling). Those decisions are ratified in ADR-0004 and listed as guardrails.

Phased order is dictated by the type-system: ACP SDK and pi-runtime bumps must come first (otherwise nothing typechecks), the `unstable_*` rename follows immediately (the bumped SDK no longer exposes those types), reactive auth classification + status emission come next (both touch `agent.ts` `newSession` and `session.ts` event handling), and runtime hardening closes out. Docs go first — review-only, no code, lets the spec be argued with before any commits.

## Guardrails (must not regress)

These are decisions ratified by ADR-0004 and earlier work. Implementation phases must preserve them:

- Per-tool formatter dispatch in `src/acp/translate/tool-content.ts` (`formatToolContent`, `wrapStreamingBashOutput`).
- Terminal-content lifecycle: `_meta.terminal_info` / `terminal_output` / `terminal_exit` when client supports it; `` ```console ``-fenced fallback otherwise.
- `_meta.piAcp.toolName` on every `tool_call` and `tool_call_update` emission, merged with terminal `_meta` where applicable.
- `markdownEscape` dynamic backtick fence wrapping for file content.
- Model alias resolution (`resolveModelPreference`).
- Prompt queueing (`promptRunning` flag + `pendingMessages` queue).
- Exhaustive event handling via `unreachable()`.
- Builtin command handlers (`/compact`, `/autocompact`, `/export`, `/session`, `/name`, `/steering`, `/follow-up`, `/changelog`).
- Standalone bin shape (`bin: { "pi-acp": "dist/index.mjs" }`).

## Components

### ACP SDK (`@agentclientprotocol/sdk`)

**Purpose**: Transport + wire-format. Provides `AgentSideConnection`, `ndJsonStream`, `Agent` interface, all ACP type definitions, JSON-RPC dispatcher.

**Key Details**:

- Current pinned version: `0.16.1`. Target: `^0.22.1`.
- Stable now (was unstable in `0.16`): `closeSession`, `resumeSession` (stabilized in `v0.20.0`). `forkSession` status TBD.
- Transport bug fixes in the gap: NDJSON decoder flush at EOS (`v0.19.1`), event ordering under nested awaits (`v0.19.2`, `v0.22.1`), unhandled rejection on mid-request transport failure (`v0.19.1`), nodenext-compatible barrel imports (`v0.21.1`).
- New unstable surfaces accumulated but explicitly out of scope: `additionalDirectories`+NES (`v0.18`), elicitation (`v0.19`), `providers/*` (`v0.21`), `session/delete` (`v0.22`), MCP-over-ACP schema (`v0.13`).

**ADR Reference**: ADR-0003 (Stable session ops).

### Pi runtime (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`)

**Purpose**: Coding-agent core. Provides `createAgentSession`, `SessionManager`, `AgentSession.subscribe`, model state, tool execution.

**Key Details**:

- Old scope: `@mariozechner/* @ ^0.62.0`. New scope: `@earendil-works/* @ ^0.75.3`.
- 13 minor versions of changes accumulated during the org migration. All three earendil packages confirmed published on public npm (`npm view @earendil-works/pi-coding-agent version` → `0.75.3`).
- Pi MCP wiring per session: **still blocked** — `createAgentSession()` in pi `0.75.3` does not accept per-session `mcpServers`. Out of scope for v0.5.

**ADR Reference**: ADR-0002 (Earendil migration).

### Auth surface (`src/acp/agent.ts` newSession, `src/acp/auth-required.ts`, `src/acp/auth.ts`)

**Purpose**: Detect auth state; advertise ACP `authMethods`; bridge to pi's terminal-login flow.

**Key Details**:

- v0.5 change: replace the proactive `hasPiAuthConfigured()` env-sniffing gate (in `src/pi-auth/status.ts`) with reactive classification — spawn pi, probe `state()` + `getAvailableModels()`, classify errors via `maybeAuthRequiredError()`. Add `cleanupFailedNewSession()` helper to handle half-created session state.
- `src/pi-auth/status.ts` is **deleted** once `hasPiAuthConfigured` is unreferenced.
- `src/acp/auth-required.ts` already contains `detectAuthError` (used by `loadSession`); v0.5 extends it as needed for pi `0.75` error shapes.
- `src/acp/auth.ts` (AuthMethod builder, terminal-login Authenticate banner `_meta`) is unchanged except for pi imports.

**ADR Reference**: ADR-0005 (Reactive auth classification).

### Session lifecycle (`src/acp/session.ts`, `src/acp/agent.ts`)

**Purpose**: ACP `Agent` interface implementation. Wraps `AgentSession` per ACP session, handles event subscription, dispatches `session/update` notifications, manages prompt queueing.

**Key Details**:

- v0.5 changes: rename `unstable_resumeSession` → `resumeSession`, `unstable_closeSession` → `closeSession`. Verify `forkSession` status. Extend `handlePiEvent` for auto-retry and auto-compaction status surfacing.
- The `initialize` handler's `agentCapabilities.sessionCapabilities` shape (`{ list, close, resume, fork }`) is verified against ACP `v0.13.2` schema during implementation.

**ADR Reference**: ADR-0001 (Standalone server — agent owns lifecycle); ADR-0003 (Stable session ops).

### Runtime entry (`src/index.ts`)

**Purpose**: Process bootstrap. Wires stdio transport, signal handlers, terminal-login subprocess for `--terminal-login` flag.

**Key Details**:

- Current state: `AgentSideConnection` over `ndJsonStream(process.stdin, process.stdout)`; `SIGINT`/`SIGTERM` handlers; `process.stdin.on("end"|"close", shutdown)` for transport-close cleanup.
- Missing: `console.{log,info,warn,debug}` redirect to stderr before any SDK call.
- Replacement: switch stdin event listeners to `connection.closed.then(shutdown)` plus a `shuttingDown` guard against double-invocation. Pattern from `claude-agent-acp/src/index.ts`.
- The `--terminal-login` block's error message currently references `@mariozechner/pi-coding-agent` — update string to new scope.

**ADR Reference**: ADR-0001.

### Status emission for pi auto-retry / auto-compaction (new in v0.5)

**Purpose**: Surface pi's internal auto-retry (rate-limit transient handling) and auto-compaction (context pruning) events to the ACP client as `session/update` content blocks.

**Key Details**:

- Pi emits both events through `AgentSession.subscribe`; pi-acp currently does not handle them, so clients see silent latency or context shrinkage with no signal.
- Pattern ported from svkozak `6b1db2c`, `5c4de3f`, `5a6baaf`. **Important**: those commits target pi `0.6x`; verify the event names and shapes against pi `0.75.3` source before porting.
- Emitted as `session/update` with status text + `_meta.piAcp.event` carrying the original event payload.

**ADR Reference**: None — implementation detail, no decision worth a standalone ADR.

### Docs surface

**Purpose**: Spec, decisions, plan, reference. Standardized on `pi-specdocs` layout.

**Key Details**:

- New: `docs/prd/PRD-001-...md` (this release).
- New: `docs/adr/ADR-0001..ADR-0005` (five foundational decisions; ADR-0004 ratifies prior v0.3.0 work).
- New: `docs/architecture/plan-acp-v013-zed-alignment.md` (this file).
- Moved: `docs/engineering/{acp-conformance,claude-acp-comparison}.md` → `docs/architecture/`.
- Deleted: `PLAN.md`, `ROADMAP.md`, `TODO.md`, `GAPS.md` (root-level legacy planning files; all phase-1–7 items in TODO.md were completed in v0.3.0; phase-8 (MCP) and phase-9 (optional features) preserved in this PRD as Out-of-scope rows with same blocker notes).

**ADR Reference**: None — the doc layout itself is the artifact.

## Implementation Order

| Phase | Component | Status | Commit |
|-------|-----------|--------|--------|
| 0 — Docs | New `docs/{prd,adr,architecture}/`; delete root planning files; update README | ✔ Shipped | `eac363a` (PR #1) |
| 1 — Toolchain | ACP SDK bump + pi runtime migration | ✔ Shipped | `52b1626` |
| 2 — Stabilize | Drop `unstable_*` prefix from `resumeSession`, `closeSession`; verify `forkSession` | ✔ Shipped (close/resume only — fork stays preview) | `d53ccfc` |
| 3 — Auth + Status | Reactive auth classification + (~~status surfacing~~ descoped) | ✔ Shipped (FR-4 only) | `750dfd6` |
| 4 — Hardening | Console redirect; `connection.closed.then(shutdown)` | ✔ Shipped | `97c82da` |
| 5 — Release | CHANGELOG, tag `v0.5.0`, GitHub release, post-release coordination | ▴ PR #2 open; semantic-release will tag on merge | — |

All four code commits landed on a single branch (`feat/acp-v013-alignment`) in PR #2 — splitting into separate PRs added no review value once the diff was bounded and typecheck-clean per commit.

## Phase Detail

### Phase 0 — Docs (this PR)

1. Create `docs/prd/`, `docs/adr/`, `docs/architecture/` directories.
2. Write `PRD-001-acp-v013-zed-alignment.md`.
3. Write `ADR-0001` through `ADR-0005`.
4. Write this plan file.
5. Move `docs/engineering/acp-conformance.md` → `docs/architecture/acp-conformance.md` (`git mv` preserves history).
6. Move `docs/engineering/claude-acp-comparison.md` → `docs/architecture/claude-acp-comparison.md` (`git mv`).
7. Delete `docs/engineering/` directory once empty.
8. Delete root `PLAN.md`, `ROADMAP.md`, `TODO.md`, `GAPS.md` — only after confirming every item in TODO.md is either marked DONE (phases 1–7), preserved as Out-of-scope in PRD (phase 8 MCP, phase 9 optional features), or absorbed into a current FR.
9. Update `README.md`:
   - Replace `@mariozechner/pi-coding-agent` reference with `@earendil-works/pi-coding-agent`.
   - Add specs/decisions section pointing at PRD-001, ADRs, plan, conformance reference.
   - Update doc-engineering link to doc-architecture.
   - Update method-name section (drop `unstable_closeSession` / `unstable_resumeSession` mentions once Phase 2 lands; for Phase 0 PR, leave intact).

### Phase 1 — Toolchain

1. `package.json`:
   - `@agentclientprotocol/sdk`: `0.16.1` → `^0.22.1`.
   - `@mariozechner/pi-coding-agent`: `^0.62.0` → `@earendil-works/pi-coding-agent@^0.75.3`.
   - Add `@earendil-works/pi-agent-core@^0.75.3` and `@earendil-works/pi-ai@^0.75.3` as explicit deps (currently transitive via pi-coding-agent).
   - Hard-bump `engines.node` from `>=20` to `>=24` (PRD Q2 resolved). Matches pi `0.75.3` constraint.
2. `bun install`. The earendil packages are public on npm, so no registry config changes expected. If install fails with 401, investigate before proceeding.
3. Scope-rename imports across `src/`:
   - `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent` (5 files).
   - `@mariozechner/pi-agent-core` → `@earendil-works/pi-agent-core` (1 file: `src/acp/translate/pi-messages.ts`).
   - `@mariozechner/pi-ai` → `@earendil-works/pi-ai` (1 file).
4. Update terminal-login error string in `src/index.ts:14-16` to reference `@earendil-works/pi-coding-agent`.
5. `bun run typecheck`. Address each error. Expected categories:
   - ACP SDK type imports: `ResumeSessionRequest`/`Response`, `CloseSessionRequest`/`Response`, content-block shape adjustments.
   - Pi SDK: event-type shape changes between `0.62` and `0.75`; message-type field renames; tool-kind enum changes.
6. `bun test`. Expect failures in component tests if pi event shapes changed; fix translate layer to match.
7. Smoke: `bun src/index.ts` driven by a `test/component/` fixture — `initialize → newSession → prompt → close`.

### Phase 2 — Stabilize session ops

1. In `src/acp/agent.ts`, rename methods on the `PiAcpAgent` class:
   - `unstable_resumeSession` → `resumeSession`.
   - `unstable_closeSession` → `closeSession`.
   - `unstable_forkSession` → `forkSession` if SDK exposes the stable name; otherwise leave prefixed and update ADR-0003 + CHANGELOG.
2. Update the `initialize` response's `agentCapabilities.sessionCapabilities`:
   - Verify `list: {}`, `close: {}`, `resume: {}`, `fork: {}` shapes against `v0.13.2` schema.
   - If schema introduces sub-fields, add them.
3. Update component tests:
   - `test/component/session-lifecycle.test.ts`.
   - `test/component/session-replay.test.ts`.
   - `test/unit/protocol-surface.test.ts`.
4. Grep guard: `grep -rn "unstable_resumeSession\|unstable_closeSession" src/` must return zero matches.

### Phase 3 — Auth + Status

**Sub-phase 3A — Reactive auth classification (FR-4):**

1. In `src/acp/agent.ts` `newSession`:
   - Delete the `hasPiAuthConfigured()` proactive gate.
   - Spawn the pi session unconditionally.
   - Call `session.proc.state()` and `session.proc.getAvailableModels()` in parallel via `Promise.all` with explicit `.catch` handlers capturing errors per call.
   - Add `cleanupFailedNewSession(sessionId, state)` helper: closes the in-memory session, unlinks the session file if it exists, removes the entry from `SessionStore`.
   - On `availableModelsErr` classified as auth-related (`maybeAuthRequiredError`): cleanup + throw `RequestError.authRequired` with `authMethods`.
   - On other `availableModelsErr`: cleanup + throw `RequestError.internalError` with original message.
   - On `availableModels.models.length === 0`: cleanup + throw `RequestError.authRequired`.
   - On `stateErr` classified as auth-related: cleanup + throw `RequestError.authRequired`.
2. Verify `src/acp/auth-required.ts` `detectAuthError` / `maybeAuthRequiredError` covers pi `0.75.3` error shapes for both `state()` and `getAvailableModels()` rejection cases. Extend with new error-shape patterns if needed.
3. Delete `src/pi-auth/status.ts` once `hasPiAuthConfigured` is unreferenced. Grep to confirm: `grep -rn "hasPiAuthConfigured\|pi-auth/status" .`
4. Add test cases in `test/unit/auth-error-detection.test.ts`:
   - Zero-models path produces `authRequired`.
   - Non-auth internal error produces `internalError`.
   - Auth-classified internal error produces `authRequired`.
   - Session cleanup is invoked on each failure path.

**Sub-phase 3B — Status emission (FR-6):**

1. Identify pi auto-retry and auto-compaction event names in pi `0.75.3` source. Open Question Q5 in PRD — these may have been renamed since svkozak's `0.6x` ports.
2. In `src/acp/session.ts`, extend `handlePiEvent` (or sibling) for the two event types:
   - Emit `session/update` with a `agent_message_chunk` content (or appropriate status chunk under `v0.13.2`).
   - Include `_meta.piAcp.event: { kind: "auto_retry" | "auto_compaction", ...payload }`.
3. Add `test/component/session-status.test.ts`: fixture-driven verification that both events produce expected ACP notifications.

### Phase 4 — Hardening

1. At the top of `src/index.ts` (before any SDK import — or at least before any SDK call):
   ```ts
   console.log = console.error;
   console.info = console.error;
   console.warn = console.error;
   console.debug = console.error;
   ```
2. Replace the `process.stdin.on("end", shutdown)` / `process.stdin.on("close", shutdown)` block with:
   ```ts
   let shuttingDown = false;
   const shutdown = async () => {
     if (shuttingDown) return;
     shuttingDown = true;
     // existing dispose logic
     process.exit(0);
   };
   agent.connection.closed.then(shutdown).catch(shutdown);
   process.on("SIGINT", shutdown);
   process.on("SIGTERM", shutdown);
   process.stdout.on("error", () => process.exit(0));
   process.stdin.resume();
   ```
   Verify the SDK exposes `connection.closed`; if the property name differs in `v0.22.1`, adapt.
3. Smoke test: `echo "" | timeout 2 ./dist/index.mjs` — process exits within the timeout, no orphan process in `ps`.

### Phase 5 — Release

1. Update `CHANGELOG.md` with a `v0.5.0` section grouping FR-1..FR-7 under "Added", "Changed", "Fixed", "Removed".
2. Bump `package.json` to `0.5.0`.
3. Commit, push, open PR(s).
4. After merge: tag `v0.5.0` via existing semantic-release workflow.
5. Open follow-up issues:
   - "Coordinate ACP registry entry with svkozak/pi-acp".
   - "Track upstream pi for per-session MCP wiring support (Phase 8)".
   - "Evaluate ACP elicitation, providers, session/delete, NES for v0.6".
   - "Evaluate move to pnpm + GitHub Packages per VSH baseline (ADR-0006)".

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pi `0.62 → 0.75` event-shape changes break translate layer | High | High | Phase 1 isolates this. Lock `0.75.3` exactly first, get tests green, then accept the caret. Component tests against recorded fixtures catch shape drift. |
| ACP SDK `0.16 → 0.22` introduces unexpected type breakage | Med | Med | Read SDK CHANGELOG entries `v0.17..v0.22` in full before Phase 1. SDK is well-typed; errors are localized. |
| `forkSession` is still preview in `v0.22.1` | Med | Low | Verify against SDK types during Phase 2. If preview, leave prefixed and note in ADR-0003 + CHANGELOG. Pi-acp's `sessionCapabilities.fork` capability stays advertised either way. |
| Reactive auth classification fires false-positive `authRequired` on transient pi errors | High | Low | `maybeAuthRequiredError` only classifies explicit auth-related error patterns; transient errors fall through to `internalError` with original message preserved. Test coverage in `test/unit/auth-error-detection.test.ts`. |
| `cleanupFailedNewSession` leaks state if pi's session-file location changes between versions | Low | Low | Helper reads `state?.sessionFile` first, falls back to `SessionStore`'s known path — same pattern as svkozak's port. |
| Auto-retry / auto-compaction event names changed since svkozak's `0.6x` ports | Med | Med | Verify against pi `0.75.3` source before porting; the events may have been renamed or restructured. PRD Q5 tracks this. |
| `connection.closed` property doesn't exist on `AgentSideConnection` in `v0.22.1` | Low | Med | Check during Phase 4. Fall back to existing stdin event listeners if API shape differs. |
| Console-redirect breaks debug logging during dev | Low | Low | Dev users can override via `PI_ACP_DEV_STDOUT=1` if needed. Add only on demand. |
| Doc migration loses actionable content | Low | Low | Phase 0 step 8: each TODO.md item is verified before deletion (phases 1–7 are checkbox-complete; phase 8/9 preserved in PRD). |

## Open Questions

- Q1: pi `0.75.3` event shape — **Resolved.** No break. Tests passed without translate-layer changes.
- Q2: `engines.node >= 24` — **Resolved.** Hard pin.
- Q3: `forkSession` stability — **Resolved.** Still preview. Handler stays prefixed.
- Q4: `modes` alongside `configOptions` — **Resolved.** Both advertised, no deprecation pressure.
- Q5: Auto-retry / auto-compaction events — **Resolved on pi side**, events exist; **descoped on ACP side** because no rendering target. See FR-6 descope note in PRD-001 §5 and PRD-002 for the deferred surface.
- Q6: ACP registry — Post-release coordination, still pending.
- Q7: pnpm / GH Packages toolchain — Separate ADR, not blocking. Number reservation dropped; future ADR claims its own slot.

## ADR Index

Decisions made for or ratified by this release:

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-0001](../adr/ADR-0001-standalone-acp-server.md) | pi-acp is a Standalone ACP Server, Not a Pi Extension | Accepted |
| [ADR-0002](../adr/ADR-0002-earendil-pi-migration.md) | Migrate Pi Dependencies from @mariozechner/* to @earendil-works/* | Accepted |
| [ADR-0003](../adr/ADR-0003-stabilize-session-ops.md) | Drop unstable_ Prefix from session/close, session/resume | Accepted |
| [ADR-0004](../adr/ADR-0004-per-tool-output-formatting.md) | Ratify Per-Tool Output Formatter Dispatch and `_meta.piAcp` Namespace | Accepted |
| [ADR-0005](../adr/ADR-0005-reactive-auth-classification.md) | Reactive Auth Classification via Pi State, Not Env-Var Sniffing | Accepted |
