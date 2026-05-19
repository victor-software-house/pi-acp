---
title: "pi-acp v0.5: ACP v0.13 + Earendil pi Alignment"
prd: PRD-001
status: Draft
owner: "Victor Araujo"
issue: "N/A"
date: 2026-05-18
version: "1.1"
---

# PRD: pi-acp v0.5: ACP v0.13 + Earendil pi Alignment

---

## 1. Problem & Context

pi-acp is the ACP (Agent Client Protocol) adapter that lets Zed (and any ACP client) drive [pi](https://github.com/earendil-works/pi) as a coding agent. The fork at `v0.4.0` shipped per-tool output formatting, terminal-content lifecycle, `_meta.piAcp.toolName` on every tool call, client-capability gating, streaming bash formatting, prompt queueing, model alias resolution, and exhaustive event handling. The Zed UX work catalogued in the legacy `PLAN.md` (phases 1–7) is **done**.

Three drifts remain open:

1. **ACP SDK is six minors stale.** Fork pins `@agentclientprotocol/sdk@0.16.1`; latest is `0.22.1` (schema `v0.13.2`). The gap includes:
   - `session/close`, `session/resume` stabilized in SDK `v0.20.0` (fork still calls `unstable_closeSession`, `unstable_resumeSession`; `unstable_forkSession` status TBD).
   - Critical transport bugfixes in `v0.18.1`, `v0.18.2`, `v0.19.1`, `v0.19.2`, `v0.21.1`, `v0.22.1` (NDJSON decoder flush at EOS, event ordering under nested awaits, unhandled rejection on mid-request transport failure, nodenext-compatible barrel imports).
   - New unstable surface accumulated but not in v0.5 scope: `additionalDirectories` + NES (`v0.18`), elicitation (`v0.19`), `providers/*` (`v0.21`), `session/delete` (`v0.22`), MCP-over-ACP schema (`v0.13`).

2. **Pi deps point at the `@mariozechner/*` scope, frozen at `0.62.0`.** Pi moved to the [earendil-works](https://github.com/earendil-works) org. The `@mariozechner/*` packages last published at `0.73.1`; `@earendil-works/*` is live at `0.75.3` and is the canonical source going forward. Fork is thirteen minor versions behind on either scope.

3. **Reactive auth classification is missing.** Fork still uses the proactive `hasPiAuthConfigured()` env-sniffing gate in `src/pi-auth/status.ts` — checks for `auth.json`, `models.json`, and a hardcoded list of provider env vars. The list goes stale every time pi adds a provider, and it doesn't reflect pi's actual model availability. svkozak `74010be` replaces this with: spawn pi → call `state()` and `getAvailableModels()` → classify any error via `maybeAuthRequiredError()`. Fork already has `detectAuthError()` in `src/acp/auth-required.ts` (the classifier) — it just doesn't run as the primary gate.

Secondary issue, also closing here: **runtime hardening**. Fork's `src/index.ts` does not redirect `console.{log,info,warn,debug}` to stderr before SDK calls. Any accidental `console.log` corrupts the ACP stdout stream. The reference `claude-agent-acp/src/index.ts` does this redirect at boot. Fork's stdin-EOF shutdown is already wired (`process.stdin.on("end", shutdown)`); the `connection.closed.then(shutdown)` pattern from `claude-agent-acp` is functionally equivalent but more idiomatic now that the SDK exposes `connection.closed`.

Tertiary issue: **doc sprawl**. Root-level `PLAN.md` (843 LOC), `ROADMAP.md` (39 LOC), `TODO.md` (220 LOC), `GAPS.md` (189 LOC), plus `docs/engineering/{acp-conformance,claude-acp-comparison}.md` (544 LOC combined) overlap and contradict. Standardizing on `@victor-software-house/pi-specdocs` (PRD / ADR / plan layout) keeps the spec surface scannable.

This PRD scopes `v0.5.0` — a focused alignment release. It does **not** revisit the formatter dispatch, terminal-content lifecycle, or `_meta` work shipped in `v0.3.0`; those decisions are ratified in ADR-0004 (existing pattern) rather than re-litigated.

---

## 2. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| **Latest ACP SDK** | `@agentclientprotocol/sdk` version in `package.json` | `^0.22.1` |
| **Latest pi runtime** | All `@mariozechner/*` deps replaced with `@earendil-works/*` at current minor | `pi-coding-agent`, `pi-agent-core`, `pi-ai` all `^0.75.3` |
| **Stable session ops** | `unstable_resumeSession`, `unstable_closeSession` handlers renamed | 0 `unstable_` occurrences for stabilized methods in `src/` |
| **Reactive auth gate** | `hasPiAuthConfigured` env-sniffing removed; auth classified from pi state + error inspection | `src/pi-auth/status.ts` deleted or reduced to a thin wrapper |
| **Stdout discipline** | `console.{log,info,warn,debug}` redirected to stderr before any SDK call | Verified by grep on `src/index.ts`; smoke test of `JSON.parse` on every stdout line during a session |
| **Conformance tests pass** | `bun test` against SDK `v0.22.1` types and pi `0.75.3` runtime | 100% pass, no test deletions |
| **Docs standardized** | Root `PLAN.md`/`ROADMAP.md`/`TODO.md`/`GAPS.md` removed; PRDs/ADRs/plans under `docs/{prd,adr,architecture}` | 1 PRD, 5 ADRs, 1 plan, 0 root planning docs |

**Guardrails (must not regress):**

- Terminal auth flow (`pi_terminal_login`) and Zed `_meta["terminal-auth"]` Authenticate banner.
- Builtin command handlers (`/compact`, `/autocompact`, `/export`, `/session`, `/name`, `/steering`, `/follow-up`, `/changelog`) — fork-local, not pi SDK-backed.
- Per-tool formatter dispatch in `src/acp/translate/tool-content.ts` (already shipped, see ADR-0004).
- Terminal-content lifecycle (`_meta.terminal_info` / `terminal_output` / `terminal_exit`) emitted when `clientCapabilities._meta.terminal_output === true`.
- `_meta.piAcp.toolName` on every `tool_call` and `tool_call_update` emission.
- Model alias resolution (`resolveModelPreference`), prompt queueing, exhaustive event handling via `unreachable()`.
- Existing test coverage in `test/unit/` and `test/component/` — no test deletions, only additions and renames matching new method names.
- Standalone bin shape — `bin: { "pi-acp": "dist/index.mjs" }` stays the same so Zed `agent_servers` configs do not break for existing users.

---

## 3. Users & Use Cases

### Primary: Zed user running pi as an external agent

> As a Zed user, I want pi-acp to follow the current SDK and pi runtime so I get the transport bugfixes (NDJSON flush, event ordering, transport-failure handling) and stable method names without having to maintain my own patched build.

**Preconditions:** Zed `agent_servers.Pi` configured with `command + args` pointing at `pi-acp` bin; pi authenticated locally.

### Primary: Pi extension developer building ACP clients

> As a developer integrating pi over ACP, I want stable `session/close` and `session/resume` so my client code does not have to track `unstable_` method renames between releases.

**Preconditions:** Client speaks ACP v0.13.x; pi-acp v0.5.0+ installed.

### Secondary: Operator running pi-acp on a fresh machine

> As an operator, I want pi-acp's auth gate to reflect pi's actual model availability so that adding a provider in pi's settings.json works immediately, without needing pi-acp to know about that provider's env-var name.

**Preconditions:** Pi installed; provider configured via `~/.pi/agent/models.json` or env var.

### Secondary: VSH maintainer

> As the maintainer, I want PRD/ADR/plan files I can hand to an LLM (or new contributor) and have them produce correct work on this codebase without first reading 1,290 lines of overlapping legacy planning docs.

---

## 4. Scope

### In scope

1. **SDK bump** — `@agentclientprotocol/sdk` `0.16.1 → 0.22.1`, type errors fixed.
2. **Pi runtime migration** — `@mariozechner/{pi-coding-agent,pi-agent-core,pi-ai}@^0.62.0` → `@earendil-works/{same}@^0.75.3`, API breakage handled.
3. **Stabilize session ops** — drop `unstable_` prefix from `resumeSession`, `closeSession` handlers. Verify `forkSession` status against `v0.22.1`; rename if stable, leave prefixed if still preview.
4. **Reactive auth classification** — replace `hasPiAuthConfigured()` proactive gate with pi-state-based detection + error classification via `maybeAuthRequiredError()`. Port pattern from svkozak `74010be`. Delete `src/pi-auth/status.ts` once unreferenced.
5. **Runtime hardening** —
   - Redirect `console.{log,info,warn,debug}` to `console.error` at the top of `src/index.ts`.
   - Replace `process.stdin.on("end", shutdown)` + `process.stdin.on("close", shutdown)` with `connection.closed.then(shutdown)` (more idiomatic; same behavior).
6. **Salvage status messages** — port pi auto-retry / auto-compaction event surfacing from svkozak `6b1db2c`, `5c4de3f`, `5a6baaf`. Verify against current pi event types; emit as `session/update` content blocks.
7. **Update terminal-login error message** — the user-facing string in `src/index.ts` points at `@mariozechner/pi-coding-agent`; update to `@earendil-works/pi-coding-agent`.
8. **Docs migration** — establish `docs/prd/`, `docs/adr/`, `docs/architecture/`; delete root planning files; preserve technical content from `docs/engineering/*` by moving under `docs/architecture/`.

### Out of scope / later

| What | Why | Tracked in |
|------|-----|------------|
| Per-tool formatter dispatch | Already shipped in v0.3.0. Ratified in ADR-0004 rather than rewritten. | ADR-0004 |
| Terminal-content lifecycle fallback | Already shipped in v0.3.0. Ratified in ADR-0004. | ADR-0004 |
| `_meta.piAcp.toolName` on tool calls | Already shipped in v0.3.0. Ratified in ADR-0004. | ADR-0004 |
| MCP server wiring per session | Pi `0.75.3` does not expose per-session MCP config on `createAgentSession()`. Still blocked. | Future PRD (when pi unblocks) |
| `session/request_permission` | Pi handles permissions internally; no external gate hook. | Future PRD |
| `agent_plan` updates | Pi has no planning/TODO surface. | Future PRD |
| `readTextFile` / `writeTextFile` client delegation | Pi operates on disk directly; no pluggable backend hook. | Future PRD |
| ACP terminal delegation (`terminal/*` agent → client) | Pi executes commands locally; would require pi to delegate. | Future PRD |
| `session/delete` (ACP v0.13.1 unstable) | Unstable, no client demand yet. | Future PRD |
| `additionalDirectories` + NES (ACP v0.18) | Pi is single-cwd per session today. | Future PRD |
| Elicitation (ACP v0.19 unstable) | No identified user need. | Future PRD |
| `providers/*` (ACP v0.21 unstable) | Pi already handles provider config via its own registry. | Future PRD |
| Migration to pnpm + GitHub Packages per VSH baseline | Fork uses bun + public npm; alignment is a separate concern. | ADR-0006 (future) |
| Submit to ACP registry (replace or alongside svkozak entry) | Coordinate with svkozak first; registry PR is a follow-up. | Post-release issue |
| Version-flag handling (`--version`) | Fork has no `--version` flag today; adding one is non-scoped UX work. The svkozak commit (`2e0b531`) only matters if a flag exists. | Future PRD |

### Design for future (build with awareness)

- **MCP wiring readiness.** The fork's `newSession` and `loadSession` handlers already accept `mcpServers` in params; they just don't pass it through. Keep that wiring in place so the day pi exposes per-session MCP config, the change is a one-line plumbing fix in `createAgentSession({ ..., mcpServers })`.
- **Auth-classification module.** When implementing FR-4, isolate auth detection in `src/acp/auth-required.ts` (already exists, just extended). Avoid scattering pi-state-reading code across `agent.ts`. This keeps the auth surface auditable when pi changes its error shape.
- **`connection.closed` pattern.** The shutdown helper should be guarded against double-invocation (a flag) so SIGINT during in-flight `connection.closed` handling does not race with shutdown.

---

## 5. Functional Requirements

### FR-1: ACP SDK bump to v0.22.1

Upgrade `@agentclientprotocol/sdk` from `0.16.1` to `^0.22.1`. Resolve all TypeScript breakage. Audit `initialize` response capabilities for shape changes between `v0.16` schema and `v0.13.2` schema.

**Acceptance criteria:**

```gherkin
Given pi-acp at v0.4.0 with @agentclientprotocol/sdk@0.16.1
When the SDK is bumped to ^0.22.1 and `bun run typecheck` is run
Then the typecheck exits 0
And `bun test` passes 100%
```

**Files:**

- `package.json` — version bump.
- `src/acp/agent.ts` — type imports, capability shape, method renames (covered by FR-3).
- `src/acp/session.ts` — event types, content types.
- `src/acp/translate/*` — content type shape.

### FR-2: Earendil pi runtime migration

Replace all three `@mariozechner/*` imports with `@earendil-works/*` at `^0.75.3`. Resolve breaking API changes between pi `0.62` and `0.75`. Update the terminal-login error message in `src/index.ts` to point at the new scope.

**Acceptance criteria:**

```gherkin
Given the source tree under src/
When `grep -r "@mariozechner" src/` is run
Then it returns no matches
And `bun run test` passes 100%
And a smoke ACP session (`initialize → newSession → prompt → close`) returns a stop_reason
```

**Files:**

- `package.json` — three dep renames + version bumps; add `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` as explicit deps (currently transitive).
- `src/acp/agent.ts` — `createAgentSession`, `SessionManager`, `AgentSession` imports updated.
- `src/acp/session.ts` — `AgentMessage`, event-type imports.
- `src/acp/translate/pi-messages.ts`, `src/acp/translate/prompt.ts` — `AssistantMessage`, `ToolResultMessage`, `UserMessage`.
- `src/pi-auth/status.ts` — pi import rename (then deleted by FR-4).
- `src/index.ts:14-16` — error string update.

### FR-3: Stabilize session/close and session/resume

Rename handlers `unstable_resumeSession → resumeSession`, `unstable_closeSession → closeSession`. Verify `forkSession` status against ACP `v0.22.1` types; rename if stable, document the exception in ADR-0003 if still preview. Update `initialize` response `sessionCapabilities` shape per `v0.13.2` schema.

**Acceptance criteria:**

```gherkin
Given an ACP v0.13.2 client
When the client calls `session/close` with a valid sessionId
Then pi-acp dispatches the stable `closeSession` handler and returns the success response
And `grep -r "unstable_" src/` returns no matches except documented exceptions
```

**Files:**

- `src/acp/agent.ts` — handler renames; `sessionCapabilities` shape verification.
- `test/component/session-lifecycle.test.ts` — method-name assertions.
- `test/component/session-replay.test.ts` — resume-flow assertions.

### FR-4: Reactive auth classification

Replace the proactive `hasPiAuthConfigured()` gate in `newSession` with a reactive pattern: spawn the pi session, call `state()` and `getAvailableModels()` in parallel, classify any error via `maybeAuthRequiredError()`. On a clean state with zero models, throw `RequestError.authRequired`. On classified auth errors, clean up the half-created session via a new `cleanupFailedNewSession()` helper.

Delete `src/pi-auth/status.ts` once `hasPiAuthConfigured` is unreferenced.

**Acceptance criteria:**

```gherkin
Given pi is installed but has no API key configured
When an ACP client calls newSession
Then pi-acp spawns the pi session, detects zero available models, cleans up state, and throws RequestError.authRequired
And the response includes authMethods so Zed shows the Authenticate banner

Given pi raises a transient internal error during getAvailableModels
When pi-acp classifies the error via maybeAuthRequiredError
Then non-auth errors propagate as RequestError.internalError with the original message
And auth errors return RequestError.authRequired
```

**Files:**

- `src/acp/agent.ts` — replace the `hasPiAuthConfigured()` check at `newSession`; add `cleanupFailedNewSession()`; parallel `state()`/`getAvailableModels()`; error classification via existing `detectAuthError`.
- `src/acp/auth-required.ts` — verify `detectAuthError` covers the error shapes pi emits at `0.75`; extend if needed.
- `src/pi-auth/status.ts` — delete after migration.
- `test/unit/auth-error-detection.test.ts` — new cases for zero-models and classified internal-error paths.

### FR-5: Runtime hardening

1. At the top of `src/index.ts`, before any SDK call:

   ```ts
   console.log = console.error;
   console.info = console.error;
   console.warn = console.error;
   console.debug = console.error;
   ```

2. Replace the current shutdown wiring with `connection.closed.then(shutdown)` plus a `shuttingDown` guard flag to prevent double-invocation from racing signal handlers. Keep `SIGINT`/`SIGTERM` handlers.

**Acceptance criteria:**

```gherkin
Given pi-acp is running an ACP session
When any code path calls `console.log("debug")`
Then the output goes to stderr, not stdout
And `JSON.parse(line)` succeeds on every stdout line

Given an ACP client closes the stdin pipe to pi-acp
When the transport closes
Then pi-acp exits within 1 second with code 0
And no orphan node/bun process remains
```

**Files:**

- `src/index.ts` — console redirect block; `connection.closed.then(shutdown)`; `shuttingDown` guard.

### FR-6: Surface pi auto-retry and auto-compaction status

Pi emits internal events when (a) the model rate-limits and pi auto-retries, and (b) when pi auto-compacts conversation context. The fork currently drops these. Subscribe in `PiAcpSession` and emit `session/update` notifications with appropriate content (status string + `_meta` indicating event source). Pattern ported from svkozak `6b1db2c`, `5c4de3f`, `5a6baaf`.

**Acceptance criteria:**

```gherkin
Given pi runtime emits an auto-retry status event during a prompt turn
When pi-acp receives the event from AgentSession.subscribe
Then pi-acp emits a session/update with a status content block indicating "pi: auto-retry" or equivalent
And the corresponding _meta carries the original event payload

Given pi runtime emits an auto-compaction event
When pi-acp receives it
Then pi-acp emits a session/update describing the compaction
And the original event details are carried in _meta
```

**Files:**

- `src/acp/session.ts` — extend `handlePiEvent` (or sibling) to handle auto-retry and auto-compaction events; emit ACP status updates.
- `test/unit/pi-messages.test.ts` or new `test/component/session-status.test.ts` — fixtures for both events.

### FR-7: Docs migration to pi-specdocs format

Establish the canonical doc layout. Remove root-level planning files. Preserve technical content from `docs/engineering/*`.

**Acceptance criteria:**

```gherkin
Given the repository at v0.5.0
When `ls` is run at the repo root
Then PLAN.md, ROADMAP.md, TODO.md, GAPS.md do not exist
And docs/prd/, docs/adr/, docs/architecture/ exist
And docs/prd/ contains PRD-001-acp-v013-zed-alignment.md
And docs/adr/ contains ADR-0001..ADR-0005
And docs/architecture/ contains plan-acp-v013-zed-alignment.md, acp-conformance.md, claude-acp-comparison.md
```

**Files:**

- `docs/prd/PRD-001-acp-v013-zed-alignment.md` — this file.
- `docs/adr/ADR-0001-standalone-acp-server.md` — codify standalone-server shape.
- `docs/adr/ADR-0002-earendil-pi-migration.md` — record `@mariozechner` → `@earendil-works`.
- `docs/adr/ADR-0003-stabilize-session-ops.md` — record `unstable_*` → stable.
- `docs/adr/ADR-0004-per-tool-output-formatting.md` — ratify the v0.3.0 dispatch pattern and `_meta.piAcp` namespace.
- `docs/adr/ADR-0005-reactive-auth-classification.md` — record proactive-gate → reactive-classification migration.
- `docs/architecture/plan-acp-v013-zed-alignment.md` — phased implementation plan.
- `docs/architecture/acp-conformance.md` — moved from `docs/engineering/`.
- `docs/architecture/claude-acp-comparison.md` — moved from `docs/engineering/`.
- Root: delete `PLAN.md`, `ROADMAP.md`, `TODO.md`, `GAPS.md`.
- `docs/engineering/` — delete directory after files move.
- `README.md` — update doc-layout pointers; update `@mariozechner` reference; add link to active PRD.

---

## 6. Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| **Compatibility** | `engines.node >= 24` — hard requirement, matches pi runtime constraint. Drops `>=20` support from v0.4.0. |
| **Wire compat** | Negotiate `protocolVersion: 1`; if client requests > 1, respond with `1` (highest supported). |
| **Stdout discipline** | Nothing other than ACP JSON-RPC frames may write to stdout. All logging on stderr. Enforced by FR-5. |
| **Test coverage** | Existing unit + component test count must not decrease. New FRs gain at least one unit test each. |
| **Lint** | Existing biome + oxlint configurations remain passing with zero new exceptions. |
| **Build** | `bun run build` via tsdown produces a working `dist/index.mjs` runnable by Zed without bundler warnings. |
| **Backwards compat** | The `bin: pi-acp` entry point, `--terminal-login` flag, and existing CLI arg shape stay the same so Zed `agent_servers` configs do not need to be edited. |

---

## 7. Risks & Assumptions

### Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Pi `0.62 → 0.75` event/type shape changes break translate layer | High | High | Phase 1 isolates this. Lock pi version to exact `0.75.3` initially; run component tests against recorded fixtures; iterate translate layer until tests pass. |
| ACP SDK `0.16 → 0.22` introduces breaking type changes beyond `unstable_*` renames | High | Medium | Read full SDK CHANGELOG before bump; have schema `v0.13.2` spec open while fixing types. Existing component tests catch wire-format regressions. |
| `forkSession` is still preview in `v0.22.1` | Medium | Medium | Verify against SDK types during Phase 2. If preview, leave prefixed and document in ADR-0003 + CHANGELOG. |
| Reactive auth classification fires false-positive `authRequired` on transient pi errors | High | Low | `maybeAuthRequiredError` only classifies explicit auth-related error patterns; transient errors fall through to `internalError`. Test coverage in `test/unit/auth-error-detection.test.ts`. |
| Deleting `src/pi-auth/status.ts` strands a callsite somewhere outside `src/` | Low | Low | Grep before deletion: `grep -r "hasPiAuthConfigured\|pi-auth/status" .` — only `src/` and `test/` are tracked. |
| `connection.closed.then(shutdown)` races with SIGINT during shutdown | Low | Low | Guard `shutdown` with `shuttingDown` flag, matching `claude-agent-acp` pattern. |
| Console-redirect breaks debug logging during dev | Low | Low | Dev users can override via `PI_ACP_DEV_STDOUT=1` if needed (optional escape hatch — add only on demand). |
| Doc migration loses actionable content from `PLAN.md` / `TODO.md` / `GAPS.md` | Low | Low | Read all four legacy files in full before deletion. Phases 1–7 in TODO.md are marked DONE; Phase 8 (MCP) and Phase 9 (optional features) are explicitly listed as Out of scope here with the same blockers documented. |
| Auto-retry/auto-compaction event shapes changed between pi `0.62` and `0.75` | Medium | Medium | Verify svkozak's events against pi `0.75.3` source before porting; the patterns may need adaptation. |

### Assumptions

- The svkozak upstream `v0.0.27` is the most recent svkozak release; the fork is the canonical VSH-scoped implementation going forward.
- Pi's public SDK surface (`createAgentSession`, `SessionManager`, `AgentSession.subscribe`) is stable across the `0.62 → 0.75` range (verified during Phase 1).
- Pi `0.75.3` exposes `session.proc.state()` and `session.proc.getAvailableModels()` (used by FR-4). To be verified during implementation.
- ACP `protocolVersion: 1` is wire-stable through schema `v0.13.x` — confirmed in the spec repo's README.
- Zed's `agent_servers.<name>` configuration shape will not change before the v0.5 release.

---

## 8. Design Decisions

### D1: Ratify v0.3.0 conformance work rather than rewrite

**Options considered:**

1. Treat v0.3.0 conformance work (per-tool dispatch, terminal-content lifecycle, `_meta.piAcp`) as in-scope for v0.5 — re-examine each, possibly migrate `_meta` namespace to `vsh.pi-acp/*`.
2. Ratify the v0.3.0 work in ADR-0004 and treat it as guardrails (must not regress); scope v0.5 only to the actual drifts.

**Decision:** Ratify.

**Rationale:** The v0.3.0 work is correct, tested, and matches the reference (`claude-agent-acp`). Renaming `_meta.piAcp.toolName` to `vsh.pi-acp/tool-kind` would break any client that reads the existing key (e.g., a Zed extension authored against the existing namespace). The slight notation difference (camelCase nested vs slash-delimited) is not worth the breakage. Document the namespace choice in ADR-0004 so future contributors don't relitigate.

### D2: Reactive auth classification over proactive env-sniffing

**Options considered:**

1. Keep `hasPiAuthConfigured()` env-sniffing. Update the env-var list as pi adds providers.
2. Replace with reactive classification: spawn pi, call `state()`/`getAvailableModels()`, classify errors.

**Decision:** Reactive classification.

**Rationale:** Documented in ADR-0005. Summary: the env-var list goes stale; pi's actual model availability is the only authoritative signal. Pattern ported from svkozak `74010be`.

### D3: Bundle SDK bump, pi migration, and auth work in one release

**Options considered:**

1. Three sequential releases.
2. Single bundled release (`v0.5.0`).

**Decision:** Single bundled release.

**Rationale:** SDK bump forces TypeScript breakage that surfaces pi `0.62 → 0.75` API changes anyway. Reactive auth classification touches `agent.ts` `newSession` — the same surface area as the SDK and pi migration. Bundling minimizes wall-clock cost and avoids two intermediate releases with non-trivial type churn.

### D4: Keep `bin: pi-acp` stable through the release

**Options considered:**

1. Rename to `pi-acp-server` to mark the standalone-server nature.
2. Keep `pi-acp`.

**Decision:** Keep `pi-acp`. Rationale documented in ADR-0001.

---

## 9. File Breakdown

| File | Change type | FR | Description |
|------|-------------|-----|-------------|
| `package.json` | Modify | FR-1, FR-2 | Bump `@agentclientprotocol/sdk` to `^0.22.1`; rename three pi deps to `@earendil-works/*` at `^0.75.3`; explicitly list `pi-agent-core` and `pi-ai`. Hard-bump `engines.node` to `>=24` to match pi runtime. |
| `src/index.ts` | Modify | FR-2, FR-5 | Update terminal-login error string to `@earendil-works/pi-coding-agent`; add `console.*` → stderr redirect; replace stdin event listeners with `connection.closed.then(shutdown)` + `shuttingDown` guard. |
| `src/acp/agent.ts` | Modify | FR-1, FR-2, FR-3, FR-4 | SDK type imports; pi imports renamed; drop `unstable_` prefix from stabilized handlers; replace `hasPiAuthConfigured` gate with reactive classification + `cleanupFailedNewSession` helper; verify `sessionCapabilities` shape. |
| `src/acp/session.ts` | Modify | FR-2, FR-6 | Pi imports renamed; extend `handlePiEvent` for auto-retry/auto-compaction status emission. |
| `src/acp/translate/tool-content.ts` | Modify | FR-2 | Pi import rename only — dispatch pattern unchanged (ratified by ADR-0004). |
| `src/acp/translate/pi-messages.ts` | Modify | FR-2 | Pi-ai/agent-core import rename; type-shape adjustments for pi 0.75 events. |
| `src/acp/translate/prompt.ts` | Modify | FR-2 | Pi import rename. |
| `src/acp/auth-required.ts` | Modify | FR-4 | Verify and extend `detectAuthError` / `maybeAuthRequiredError` for pi 0.75 error shapes. |
| `src/acp/auth.ts` | Modify | FR-2 | Pi import rename (if any); otherwise unchanged. |
| `src/pi-auth/status.ts` | Delete | FR-4 | Remove `hasPiAuthConfigured` env-sniffing after migration to reactive classification. |
| `test/unit/auth-error-detection.test.ts` | Modify | FR-4 | Cover zero-models path and internal-error classification path. |
| `test/component/session-lifecycle.test.ts` | Modify | FR-3 | Method-name assertions for stable session ops. |
| `test/component/session-replay.test.ts` | Modify | FR-3 | Resume-flow assertions. |
| `test/unit/protocol-surface.test.ts` | Modify | FR-3 | Assert no `unstable_*` references for stabilized methods. |
| `test/component/session-status.test.ts` | New | FR-6 | Fixtures for auto-retry and auto-compaction event surfacing. |
| `docs/prd/PRD-001-acp-v013-zed-alignment.md` | New | FR-7 | This file. |
| `docs/adr/ADR-0001-standalone-acp-server.md` | New | FR-7 | Standalone-server shape. |
| `docs/adr/ADR-0002-earendil-pi-migration.md` | New | FR-7 | Pi scope migration. |
| `docs/adr/ADR-0003-stabilize-session-ops.md` | New | FR-7 | `unstable_*` → stable. |
| `docs/adr/ADR-0004-per-tool-output-formatting.md` | New | FR-7 | Ratify v0.3.0 dispatch + `_meta.piAcp` namespace. |
| `docs/adr/ADR-0005-reactive-auth-classification.md` | New | FR-7 | Proactive-gate → reactive-classification migration. |
| `docs/architecture/plan-acp-v013-zed-alignment.md` | New | FR-7 | Phased implementation plan. |
| `docs/architecture/acp-conformance.md` | Move | FR-7 | From `docs/engineering/`. |
| `docs/architecture/claude-acp-comparison.md` | Move | FR-7 | From `docs/engineering/`. |
| `PLAN.md`, `ROADMAP.md`, `TODO.md`, `GAPS.md` | Delete | FR-7 | Content superseded by PRD + ADRs + plan. |
| `docs/engineering/` | Delete | FR-7 | Empty after moves. |
| `README.md` | Modify | FR-2, FR-7 | Update `@mariozechner` → `@earendil-works`; add doc-layout pointers; link to active PRD. |
| `CHANGELOG.md` | Modify | FR-1..FR-7 | New `v0.5.0` section. |

---

## 10. Dependencies & Constraints

- `@agentclientprotocol/sdk@^0.22.1` (peer: `zod@^3.25.0 || ^4.0.0`).
- `@earendil-works/pi-coding-agent@^0.75.3`.
- `@earendil-works/pi-agent-core@^0.75.3`.
- `@earendil-works/pi-ai@^0.75.3`.
- All three earendil packages confirmed published on public npm at `0.75.3` (verified via `npm view`).
- Pi runtime `engines.node >= 24` (upstream constraint). pi-acp v0.5 hard-pins `engines.node >= 24` to match.
- Pi runtime minimum: `^0.75.3`. No support for prior versions in v0.5.
- ACP wire compat: `protocolVersion: 1` only (schema `v0.13.x`).
- Build tool: `tsdown ^0.21.4` (unchanged).
- Lint: `biome ^2.4.8` + `oxlint ^1.56.0` (unchanged).
- Test: `bun test` (unchanged).

---

## 11. Rollout Plan

1. **Phase 0 — Docs.** This PRD + five ADRs + plan land on a feature branch. No code changes yet. Doc reviewers can challenge scope before implementation begins.
2. **Phase 1 — Toolchain.** SDK bump + pi runtime migration (FR-1, FR-2). One PR. Type-check passes, smoke test passes.
3. **Phase 2 — Stabilize.** Drop `unstable_` from `resumeSession`, `closeSession` (FR-3). One PR. Tests updated.
4. **Phase 3 — Auth + status.** Reactive auth classification (FR-4) + auto-retry/auto-compaction status surfacing (FR-6). One PR. New test coverage.
5. **Phase 4 — Hardening.** Console redirect + connection.closed shutdown (FR-5). Small PR.
6. **Cut `v0.5.0`.** CHANGELOG entry summarizes phases.
7. **Post-release:** open coordination issue with svkozak about ACP registry entry; open MCP-wiring tracking issue against upstream pi.

---

## 12. Open Questions

| # | Question | Owner | Due | Status |
|---|----------|-------|-----|--------|
| Q1 | Does pi `0.75.3` event-shape break the translate layer beyond the scope rename? | Victor | Phase 1 PR | Open |
| Q2 | Should we bump `engines.node` to `>=24` to match pi runtime, or stay on `>=20` for broader install compat? | Victor | Phase 1 PR | **Resolved:** `engines.node >= 24` is a hard requirement. Matches pi `0.75.3` constraint. |
| Q3 | Is `forkSession` stable in `@agentclientprotocol/sdk@v0.22.1`? | Victor | Phase 2 PR | Open |
| Q4 | Should pi-acp continue advertising `modes` alongside `sessionConfigOptions` for back-compat? | Victor | Phase 2 PR | Open — lean yes (spec note explicitly recommends advertising both during the deprecation window). |
| Q5 | Do auto-retry and auto-compaction events exist in pi `0.75.3` event types, or did the event names change since svkozak ported them at pi `0.6x`? | Victor | Phase 3 PR | Open |
| Q6 | Replace svkozak in the ACP registry or coexist? | Victor | Post-release | Open — outreach required. |
| Q7 | Move pi-acp toolchain from bun + public npm to pnpm + GitHub Packages per VSH baseline? | Victor | Future | Open — separate ADR (ADR-0006, future). |

---

## 13. Related

| Issue | Relationship |
|-------|-------------|
| `svkozak/pi-acp@v0.0.27` | salvage-source |
| `agentclientprotocol/typescript-sdk@v0.22.1` | depends-on |
| `agentclientprotocol/agent-client-protocol@v0.13.2` | wire-spec |
| `earendil-works/pi@v0.75.3` | depends-on |
| `agentclientprotocol/claude-agent-acp@v0.36.1` | reference-impl |
| `victor-software-house/pi-specdocs` | enables-doc-format |

---

## 14. Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-05-18 | Initial draft (v1.0) — over-scoped FR-4/5/6 against fork's actual state | Victor |
| 2026-05-18 | v1.1 — corrected scope after reading legacy `PLAN.md`/`TODO.md`/`GAPS.md`. v0.3.0 conformance work moved to Out-of-scope (ratified in ADR-0004). Added FR-4 reactive auth classification, FR-6 auto-retry/auto-compaction status. | Victor |

---

## 15. Verification (Appendix)

Post-implementation checklist:

1. `cat package.json | grep agentclientprotocol/sdk` shows `^0.22.1`.
2. `grep -r "@mariozechner" .` returns no matches outside `node_modules/`.
3. `grep -r "unstable_resumeSession\|unstable_closeSession" src/` returns no matches.
4. `grep -r "hasPiAuthConfigured" src/ test/` returns no matches; `src/pi-auth/status.ts` is deleted.
5. `node -e 'process.stdout.write = (chunk) => { JSON.parse(chunk.toString()); }' && bun src/index.ts < fixture-session.ndjson` — every stdout line is valid JSON-RPC.
6. Close stdin to a running pi-acp process — process exits within 1 second; no orphan node/bun process remains in `ps`.
7. Launch Zed with `agent_servers.Pi.command` pointing at the new bin; run an unauthenticated session — Zed shows the Authenticate banner via the reactive auth gate.
8. Trigger an auto-retry condition (rate-limit the model API) — Zed shows a status update with "pi: auto-retry".
9. `ls docs/` shows `prd/`, `adr/`, `architecture/`. `ls docs/engineering/` returns "No such file or directory". `ls *.md | grep -E '^(PLAN|ROADMAP|TODO|GAPS)\.md$'` returns nothing.
10. CI passes on a fresh clone: `bun install && bun run typecheck && bun run lint && bun test && bun run build`.
