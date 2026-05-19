---
title: "pi-acp v0.6: Portable Runtime + Multi-Host Resource Composition"
prd: "PRD-002-portable-runtime"
date: 2026-05-19
author: "Victor Araujo"
status: Draft
---

# Plan: pi-acp v0.6 — Portable Runtime + Multi-Host Resource Composition

## Source

- **PRD**: `docs/prd/PRD-002-portable-runtime.md`
- **Sibling plan**: `docs/architecture/plan-runtime-daemon.md` — backends in this plan land **after** the daemon skeleton, plugging into `DaemonContext` shared singletons.
- **Date**: 2026-05-19
- **Author**: Victor Araujo

## Architecture Overview

pi-acp `v0.5` is a single-cwd / single-host adapter — every ACP session binds to one local working directory and reads context from one local filesystem via pi's `DefaultResourceLoader`. v0.6 decouples three things that today live in the same axis:

1. **Where pi-acp runs** (the host).
2. **Where its tools target** (the cwd).
3. **Where its resources come from** (discovery roots).

The decoupling is achieved with three additions, no pi fork:

- **`VirtualResourceLoader`** (ADR-0006): a custom implementation of pi's `ResourceLoader` interface that aggregates from multiple `ResourceSource` instances. Plugged into pi via `createAgentSession({ resourceLoader })`.
- **Resource composition manifest** (ADR-0008): a YAML file (`.pi-acp.yaml`) declares which sources to compose, what backend each uses, and how to merge. Cascade: ACP session-param > project > user-global > synthesized default.
- **Cwd-independence modes** (ADR-0009): `local | overlay | none`. `local` preserves v0.5 behavior; `overlay` adds aux resource roots; `none` runs cwd-less in a tmpdir.

Plus two surface features:

- **ACP-FS delegation for `read`** (ADR-0007): when client advertises `clientCapabilities.fs.readTextFile`, pi's built-in `read` is replaced by a custom tool that proxies through `connection.fs.readTextFile`. Zed Remote routes that to the remote machine.
- **`import_resource` custom tool**: agent-invokable pull of a remote resource into the live session via `resourceLoader.extendResources()`.

## Guardrails (must not regress)

- v0.5 reactive auth path stays identical (PRD-001 FR-4).
- Existing 186 tests pass unmodified.
- Local-mode session start latency unchanged when manifest absent.
- `_meta.piAcp.*` namespace preserved; new keys are additive.
- `bin: pi-acp`, `--terminal-login`, semantic-release pipeline untouched.
- No fork of `@earendil-works/pi-coding-agent`.

## Mandatory Skill Loads

| Phase / file | Load before edits |
|---|---|
| Phase 2 (`src/resources/manifest.ts`, `manifest.schema.ts`) | `zod`, `typescript-type-safety` |
| Phase 3 (`src/resources/sources/ssh.ts`) | `bun-shell` (uv-shebanged Python under `scripts/` only for non-runtime helpers) |
| Phase 4 (`src/resources/sources/http.ts`) | `typescript-type-safety` (Bun.fetch + Zod response shapes) |
| Phase 5 (`src/resources/sources/acp-fs.ts`, `src/resources/tools/acp-read.ts`) | `pi-tool-progressive-disclosure`, `pi-extension-writing` |
| Phase 6 (`src/resources/tools/import-resource.ts`) | `pi-tool-progressive-disclosure`, `pi-extension-writing` |
| Phase 7 (`src/resources/modes.ts` tmpdir lifecycle) | `bun-shell` (`$\`mktemp -d …\``) |
| Phase 8 (diagnostics surface) | `pi-rendering-style`, `pi-footer-status` |
| Any phase (lint / pre-push / release) | `linting-stack`, `lefthook-config`, `greenfield-release` |

The full mapping (FR → skill, with rationale) lives in PRD-002 §16.

## Components

### `VirtualResourceLoader` (new — `src/resources/loader.ts`)

**Purpose**: Implement pi's `ResourceLoader` interface as a composer over `ResourceSource` instances.

**Key details**:

- Constructor: `new VirtualResourceLoader({ sources, mergeStrategy, diagnosticsSink })`.
- `reload()` runs every source's `reload()` in parallel with per-source timeout (default 5s). Failures captured as diagnostics; reload always resolves.
- Each accessor (`getSkills`, `getPrompts`, `getAgentsFiles`, `getExtensions`, `getThemes`) aggregates contributions across sources. `mergeStrategy: "append"` concatenates; `mergeStrategy: "override-by-name"` deduplicates by ID with later-source-wins semantics.
- `extendResources()` routes to a synthesized `LocalBackend` side-cache so `import_resource` results survive the session.

**ADR Reference**: ADR-0006.

### `ResourceSource` backends (new — `src/resources/sources/`)

**Purpose**: Backend-specific resource discovery + reads, behind a uniform interface.

**Key details**:

- `base.ts` — shared `ResourceSource` interface + helpers (path normalization, skill parsing, prompt frontmatter parsing).
- `local.ts` — `LocalBackend`. Wraps pi's `loadProjectContextFiles`, `loadSkills`, `loadSkillsFromDir` for one root. No remote calls.
- `acp-fs.ts` — `AcpFsBackend`. Reads via `connection.fs.readTextFile`. Listing relies on manifest-declared file lists (ACP has no `fs/listDir`).
- `ssh.ts` — `SshBackend`. Shipped Phase 6 as a single Bun Shell `$` line: `${sshCommand} -o BatchMode=yes -o ConnectTimeout=${sec} -o ServerAliveInterval=2 -o ServerAliveCountMax=${alive} ${target} -- cat ${path}`. ssh self-terminates via its own options — no caller-side wrapper, no perl alarm, no `timeout(1)`. Operator's `~/.ssh/config` (`ControlMaster auto`, `ControlPersist 10m`) handles spawn-cost amortization for free. `ShellPromise` has no `.timeout()` (verified at runtime against bun 1.3.14); ssh's options are the correct layer. Scope: AGENTS files via explicit `paths.agentsFiles` list; skills/prompts/extensions over SSH stay deferred and surface one diagnostic each. *(Skill: `bun-shell` mandatory before edits here.)*
- `http.ts` — `HttpBackend`. HTTPS-only `fetch`. Per-source `cache.ttl` (default 300s, in-memory).

**ADR Reference**: ADR-0007 (delegation gate for `acp-fs`).

### Manifest (new — `src/resources/manifest.ts`, `src/resources/manifest.schema.ts`)

**Purpose**: Declarative configuration of which sources to compose.

**Key details**:

- Zod schema in `manifest.schema.ts`. Validates `version: 1`, `mode`, each `root`'s shape per `kind`, `mergeStrategy`, optional `auto-import` and `diagnostics`. *(Skills: `zod` + `typescript-type-safety` mandatory. `import * as z from 'zod'` namespace; `safeParse` only; `z.enum` for `mode`/`mergeStrategy`; discriminated union on `root.kind` for O(1) validation.)*
- Cascade resolver in `manifest.ts`:
  1. ACP session params (`params._meta.piAcp.manifest` — full inline manifest or path).
  2. Project (`<cwd>/.pi-acp.yaml`).
  3. User-global (`~/.pi-acp/config.yaml`).
  4. Synthesized default.
- Shallow merge at top level; `roots[].id` is the merge key.
- Parse failures: fall back to default, emit diagnostic. Per-source schema failures: drop that source, emit per-source diagnostic.

**ADR Reference**: ADR-0008.

### Custom tools (new — `src/resources/tools/`)

**Purpose**: Agent-invokable extension surface for resource ops + ACP-FS delegation.

**Key details**:

- `import-resource.ts` — `import_resource` tool. Args: `{ sourceId, kind, path, alias? }`. Returns one-line summary or structured error.
- `acp-read.ts` — `acp_read` tool. Same name (`read`) and schema as pi's built-in. Implementation: `connection.fs.readTextFile({ sessionId, path })`.

Both registered via `createAgentSession({ customTools })`. `read` delegation also passes `tools: ["bash", "edit", "write", "grep", "find", "ls"]` to disable pi's built-in `read`.

*(Skills: `pi-tool-progressive-disclosure` mandatory for both files. Use `StringEnum` over `anyOf`/`oneOf`; keep `promptSnippet` minimal; gate `import_resource` activation via `setActiveTools()` so it stays out of the model-visible set when no non-local source is configured. `pi-extension-writing` references `custom-tools-and-tool-overrides.md` for the override contract.)*

**ADR Reference**: ADR-0007 (`acp-read`), no ADR for `import_resource` (mechanical extension of FR-4).

### Cwd modes (new — `src/resources/modes.ts`)

**Purpose**: Handle `local | overlay | none` mode semantics, including tmpdir lifecycle for `none`.

**Key details**:

- `resolveMode(manifest, params)` returns the effective mode after cascade.
- `createTmpdirCwd(sessionId)` for `none` mode — creates `os.tmpdir() + "/pi-acp-session-<id>/"` with mode `0700`. Implementation prefers `await $\`mktemp -d ${tmpRoot}/pi-acp-session-${sessionId}-XXXXXX\`.text()` (skill: `bun-shell`).
- Cleanup hooks bound to `session/close`, `AgentSideConnection.closed`, and SIGINT/SIGTERM (reuses existing `shuttingDown` guard from v0.5).
- `overlay` mode is the manifest's responsibility — `modes.ts` just confirms the primary cwd is valid; aux roots are resolved by the loader.

**ADR Reference**: ADR-0009.

### Diagnostics (new — `src/resources/diagnostics.ts`)

**Purpose**: One-line per-source summary at session start. Opt-in via manifest `diagnostics: true`.

**Key details**:

- Emitted as `agent_message_chunk` updates at the start of the first prompt's response (chosen surface — session boundary, not interleaved with model text).
- Format:
  ```
  [pi-acp] resources active:
    local           cwd=. agentDir=~/.pi/agent (12 AGENTS files, 3 skills, 5 prompts)
    vsh-shared      ssh varaujo@cvm (8 skills, 2 prompts)
  [pi-acp] resource failures:
    team-context    AGENTS.md (HTTP 404)
  ```
- Failed sources surface in a second block with `[failed]` and the underlying reason (timeout, HTTP status, ssh exit code).

**ADR Reference**: None — implementation detail.

### Wiring (`src/acp/agent.ts` modifications)

**Purpose**: Connect manifest → loader → `createAgentSession`.

**Key details**:

- `newSession` / `resumeSession` / `loadSession`: resolve manifest before `createAgentSession`; build `VirtualResourceLoader` from sources; pass through `resourceLoader`, `tools`, `customTools`, `agentDir` per manifest.
- `acp-fs` delegation: gate on `this.clientCapabilities.fs?.readTextFile === true`.
- Tmpdir lifecycle for `none` mode: track per-session, dispose on `session/close`.

## Implementation Order

Numbering aligns with the combined PRD-002 + PRD-003 phase sequence shipped on the v0.6 train. Phases 1–3 belong to PRD-003 (daemon foundation); this plan covers Phases 4 onward.

| Phase | Component | Dependencies | Estimated Scope |
|-------|-----------|--------------|-----------------|
| 0 — Docs | PRD-002 + ADR-0006..0009 + this plan | None | M (shipped) |
| 4 — Loader skeleton | `VirtualResourceLoader` + `LocalBackend` only | Phase 0 | M (shipped) |
| 5 — Manifest | Cascade resolver + Zod schema + YAML parser dep | Phase 4 | M (shipped) |
| 6 — SSH backend | `SshBackend` + tests against fake-ssh fixture | Phase 4 | M (shipped) |
| 7 — HTTP backend | `HttpBackend` + tests via injected `fetchImpl` stub | Phase 4 | M (shipped) |
| 8a — FR-6 read tool delegation | pi's `createReadToolDefinition` + `ReadOperations` injection + `customTools` overlay gated on `fs.readTextFile` | Phase 4 | M (shipped) |
| 8b — `AcpFsBackend` (deferred) | AGENTS-file discovery over ACP; blocked on sessionId-not-yet-available at `buildResourceLoader` time | Phase 4 | open design |
| 9 — `import_resource` tool | Custom tool + `extendResources` wiring | Phases 4, 5 | deferred (Q1 verification) |
| 10 — Cwd modes | `none` tmpdir lifecycle via `resolveMode` + `PiAcpSession.cleanups`; `local`/`overlay` documented as identical passthrough | Phases 4, 5 | M (shipped) |
| 11 — Diagnostics + release | Diagnostic surface, README, CHANGELOG, tag v0.6.0 | All prior | S |

Phases 6–7 can swap order. Phase 8 depends on Phases 4+5. Phase 9 depends on Phases 4+5.

## Phase Detail

### Phase 0 — Docs (in flight on this branch)

1. `docs/prd/PRD-002-portable-runtime.md` ✔ written.
2. `docs/adr/ADR-0006-virtual-resource-loader.md` ✔ written.
3. `docs/adr/ADR-0007-acp-fs-delegation.md` ✔ written.
4. `docs/adr/ADR-0008-resource-composition-manifest.md` ✔ written.
5. `docs/adr/ADR-0009-cwd-independence-modes.md` ✔ written.
6. `docs/architecture/plan-portable-runtime.md` (this file).
7. PRD-001 + plan-acp-v013-zed-alignment status corrections ✔.

### Phase 1 — Loader skeleton

1. `src/resources/loader.ts` — `VirtualResourceLoader` class implementing pi's `ResourceLoader` interface.
2. `src/resources/sources/base.ts` — `ResourceSource` interface + shared helpers.
3. `src/resources/sources/local.ts` — `LocalBackend`. Delegate to pi's exported `loadProjectContextFiles`, `loadSkills`, `loadSkillsFromDir`.
4. Wire `VirtualResourceLoader` in `src/acp/agent.ts` with a single `LocalBackend` matching v0.5 behavior. No manifest yet — synthesize default config inline.
5. `bun test` — all 186 tests pass unmodified. New `test/unit/resources/sources-local.test.ts` adds coverage.
6. `bun run typecheck` clean.

**Acceptance**: pi-acp behavior is byte-identical to v0.5 from the outside. Internally, `DefaultResourceLoader` is no longer instantiated; `VirtualResourceLoader` with one `LocalBackend` replaces it.

### Phase 2 — Manifest

1. Add `yaml@^2.x` dep.
2. `src/resources/manifest.schema.ts` — Zod schema for the manifest. Strict on `version` and `kind` enums; lenient on unknown top-level keys (warning diagnostic).
3. `src/resources/manifest.ts`:
   - `loadManifest({ cwd, sessionParams })` → resolved manifest after cascade.
   - Cascade order: ACP session params > project > user-global > synthesized default.
   - On parse failure: synthesized default + diagnostic.
4. Wire manifest into `src/acp/agent.ts`. With no manifest present, behavior unchanged. With a project manifest declaring a single local source, behavior unchanged. With a manifest declaring multiple `local` sources, both contribute resources.
5. Tests in `test/unit/resources/manifest.test.ts`:
   - Cascade precedence.
   - Schema validation success + failure.
   - Per-source error handling.

**Acceptance**: Manifests at all three cascade levels are correctly resolved. Multiple `local` sources can coexist and contribute resources. Tests pass.

### Phase 6 — SSH backend *(shipped)*

> *Originally tracked here as "Phase 3"; renumbered to Phase 6 in §Implementation Order to align with PRD-003's daemon-foundation phase numbering.*

1. `src/resources/sources/ssh.ts` — `SshBackend.cat` is one Bun Shell `$` line:

   ```ts
   await $`${sshCommand} -o BatchMode=yes -o ConnectTimeout=${sec} -o ServerAliveInterval=2 -o ServerAliveCountMax=${alive} ${target} -- cat ${path}`.quiet().nothrow();
   ```

   Timeout enforcement lives at the ssh-protocol layer: `ConnectTimeout=N` bounds TCP + handshake; `ServerAliveInterval=2 -o ServerAliveCountMax=N` bound post-auth silence on a stalled remote. ssh self-terminates without any caller-side wrapper. `ShellPromise` has no `.timeout()` (verified at runtime against bun 1.3.14 — only `cwd/env/quiet/nothrow/throws/text/json/lines/arrayBuffer/bytes/blob/run/then`); ssh's own options are the right layer. Operator's `~/.ssh/config` (`ControlMaster auto`, `ControlPersist 10m`) amortizes spawn cost from ~70ms cold to ~5ms warm on the same host within 10 minutes. Interpolations are auto-escaped by Bun Shell.
2. No helper script in `scripts/` — earlier iterations of this phase used a uv-shebanged Python helper and then an inline perl alarm; both removed once ssh's own ServerAlive options proved sufficient for the realistic stall modes.
3. **Scope**: AGENTS files via explicit `paths.agentsFiles` list only. Skills, prompts, and extensions over SSH stay deferred (no remote `find` discovery in this phase); declaring `paths.skills` / `.prompts` / `.extensions` surfaces one `"not yet implemented"` diagnostic per kind via `getSkills()` aggregation.
4. `sshCommand?` constructor option threads through to the Python helper's `--ssh` arg so tests can point at an absolute-path Bash shim. Bun Shell `$` (and `Bun.spawn`) do NOT honor runtime `process.env.PATH` mutations for argv[0] resolution — verified empirically — so an explicit override is the portable test path.
5. `ResourceSource.getExtensions` was made optional in this phase; `VirtualResourceLoader` routes extensions through the primary `LocalBackend` only.
6. Manifest roots with `kind: "ssh"` materialize into `SshBackend` instances in `PiAcpAgent.buildResourceLoader`.
7. Tests in `test/unit/ssh-backend.test.ts` (6 cases):
   - cat round-trip + ssh:// path qualification (shim shadows ssh, helper reads it).
   - Non-zero ssh exit surfaces as warning diagnostic without throwing.
   - Unsupported-kind diagnostics when `paths.skills` / `.prompts` / `.extensions` declared.
   - Argv assertion: the shim records the full argv; tests verify the expected `-o ConnectTimeout` / `-o ServerAliveInterval` / `-o ServerAliveCountMax` options reach ssh.
   - Default getters return empty when no agentsFiles declared.
8. End-to-end verified against real ssh to `127.0.0.1`: ~70ms round-trip, exit 255 / "Host key verification failed." stderr forwarded cleanly.

**Acceptance**: SSH source contributes AGENTS files from a remote host. Failure modes (timeout, non-zero exit, missing path) surface as diagnostics, not exceptions. **Shipped on `feat/v0.6-foundation-refactor` (commits `2cdc385`, `b13ddde`, `5869a40`, `c610bb5`).**

### Phase 4 — HTTP backend

1. `src/resources/sources/http.ts` — `HttpBackend`. HTTPS-only `fetch`.
2. Per-URL in-memory cache with TTL (default 300s). Cache survives across `reload()` calls so repeated session bootstraps within the TTL window skip the network. `cacheTtlSeconds: 0` defeats caching.
3. List operations: manifest must declare explicit `paths.agentsFiles` (HTTP has no listing primitive). Skills/prompts/extensions over HTTP surface one diagnostic per declared kind.
4. Per-request timeout via `AbortController` (default 5_000ms). Aborted fetches surface as `fetch timed out after Nms` diagnostics.
5. Tests in `test/unit/http-backend.test.ts` (13 cases). Use an injected `fetchImpl` stub (typed as `typeof fetch`) instead of a fixture HTTPS server — Bun's `fetch` doesn't expose a TLS-relaxed mode for self-signed certs, and the production code path stays untouched in tests since the stub mirrors the exact `fetch(url, init?) => Promise<Response>` shape. Coverage:
   - Constructor rejects `http://` and `ftp://`; accepts `https://` and strips trailing slash.
   - Empty `paths.agentsFiles` → empty file list, no fetch calls.
   - Successful multi-file fetch with baseUrl + path qualification.
   - Leading-slash path dedupe.
   - 4xx surfaces as warning diagnostic without throwing.
   - `fetch`-throws surfaces as diagnostic.
   - Hanging fetch + short `timeoutMs` triggers AbortController → diagnostic.
   - Cache hit on second reload within TTL — no extra fetch.
   - `cacheTtlSeconds: 0` forces refetch every reload.
   - Unsupported-kind diagnostics when `paths.skills` / `.prompts` / `.extensions` declared.
   - Default getters return empty / undefined.
6. Wiring in `src/acp/agent.ts`: `kind: "http"` branch in `buildResourceLoader` instantiates `HttpBackend` with `cacheTtlSeconds: root.cache?.ttl` from the manifest.

**Acceptance**: HTTP source contributes AGENTS files from a public URL. Cache TTL respected (verified by stub call counts). Non-HTTPS rejected at construction. **Shipped on `main`.**

### Phase 5 — FR-6 read tool delegation (8a, shipped) + AcpFsBackend (8b, deferred)

**Phase 8a — FR-6 read tool ACP-FS delegation (shipped)**

1. `src/acp/acp-read-operations.ts` — `createAcpReadOperations({ conn, getSessionId })`. Returns a pi `ReadOperations` object. `readFile(absolutePath)` calls `conn.readTextFile({ sessionId, path: absolutePath })` and returns `Buffer.from(response.content, "utf8")`. `access` issues a probe read and discards the body. `detectImageMimeType` omitted (ACP fs is text-only).
2. `src/acp/client-capabilities.ts` — extend `ClientCapabilityFlags` with `fsReadTextFile: boolean` reading `caps.fs?.readTextFile === true`.
3. `src/acp/agent.ts` — `buildAcpReadOverlay(cwd)` private helper. When `clientCapabilities.fsReadTextFile === false`, returns `null` and the agent skips the overlay (pi's built-in `read` handles everything). When `true`, returns `{ sessionIdRef, tools, customTools }`:
   - `tools: ["read", "bash", "edit", "write", "grep", "find", "ls"]`. The allowlist MUST include `"read"` — verified against `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1811` where `allowedToolNames` filters BOTH builtins AND customTools by name. The customTool then shadows the builtin via the tool-definition `Map.set` path at line 1821. (PRD wording said "exclude read" — this is incorrect; corrected here.)
   - `customTools: [createReadToolDefinition(cwd, { operations })]` where `operations` is the ACP-routed `ReadOperations`.
   - `sessionIdRef: { current: "" }` — late-bound. The agent mutates `sessionIdRef.current = piSession.sessionManager.getSessionId()` immediately after `createAgentSession` returns. The tool isn't invoked until prompt-time, so the late binding is safe. `operations.readFile` throws `"sessionId not yet bound"` if called before the ref is set (defensive guard).
   - Wired into all 4 session-creation paths: `newSession`, `loadSession`, `resumeSession`, `forkSession`.
4. Tests in `test/unit/acp-read-operations.test.ts` (8 cases) + extended `test/unit/client-capabilities.test.ts` (3 cases):
   - `readTextFile` routing returns `Buffer` with utf8 content.
   - Empty `sessionId` throws `"sessionId not yet bound"`.
   - Late-bound ref: first call throws, then ref mutates, second call succeeds.
   - Connection errors propagate to caller.
   - `access` issues a probe and discards the body; errors propagate.
   - `detectImageMimeType` not advertised.
   - `parseClientCapabilities` reads `caps.fs.readTextFile` (true / absent / explicit-false).

**Acceptance**: When client advertises `fs.readTextFile`, `read` tool calls route through `conn.readTextFile`. When absent, pi's built-in handles reads locally. **Shipped on `main`.**

**Phase 8b — AcpFsBackend (deferred — open design)**

Architectural snag: `AcpFsBackend` would need `sessionId` to call `conn.readTextFile({ sessionId, path })` for AGENTS-file discovery at session-start, but `sessionId` isn't available at `buildResourceLoader` time (pi mints it inside `createAgentSession`, after the loader is built).

Three viable shapes:
1. **Late-bound reload** — backend records "sessionId not bound" diagnostic on first reload; agent re-triggers reload after session creation. Requires `VirtualResourceLoader.reloadOne(sourceId)` to avoid re-fetching SSH/HTTP sources twice per session start.
2. **Pre-mint sessionId** — generate UUID before `createAgentSession`, pass to both the backend AND inject into pi via a SessionManager constructor that accepts an external id. Verify pi accepts external id (`SessionManager.create` currently mints internally).
3. **Drop the use case** — SSH source already covers "read remote agent files" for any reachable host. ACP-FS for discovery only adds value when the operator's only path to the remote FS is through the ACP client (e.g., a Zed Remote target with no SSH access). Unclear if this scenario matters in v0.6.

Decision deferred to follow-up review with concrete user demand evidence.

### Phase 6 — `import_resource` custom tool

1. `src/resources/tools/import-resource.ts` — `importResourceTool`. Pi `ToolDefinition`.
2. On invocation:
   - Look up `ResourceSource` by `sourceId`. 404 if not found.
   - Call kind-specific fetcher (`source.fetchSkill(path)`, etc.).
   - Validate shape (skill = `SKILL.md` present + frontmatter parseable; prompt = `.md` with frontmatter; AGENTS file = any text).
   - Call `resourceLoader.extendResources({ skillPaths: [...] })` (or analogous).
   - Return success summary or structured error.
3. Verify Q1 (PRD-002 §12): does `extendResources()` work mid-session? Read pi source to confirm; if it only works at session start, document the constraint and surface to the user. (Open question — may force `import_resource` to only stage imports for the next prompt cycle.)
4. Tests in `test/unit/resources/import-resource.test.ts`:
   - Source-not-configured error.
   - Kind mismatch error.
   - Successful import reflected in subsequent `getSkills()`.

**Acceptance**: `import_resource` tool reachable from the model. Successful imports show up in subsequent resource accessors. Errors are structured and recoverable.

### Phase 7 — Cwd modes

1. `src/resources/modes.ts`:
   - `resolveMode(manifest, params)` → `"local" | "overlay" | "none"`.
   - `createEphemeralCwd(sessionId)` for `none` mode.
   - Cleanup registration (binds to existing `shuttingDown` flow).
2. Wiring in `src/acp/agent.ts`:
   - `local`: today's behavior.
   - `overlay`: use ACP `cwd` for pi tool target; manifest aux roots resolved by loader.
   - `none`: substitute tmpdir for pi `cwd`; manifest provides all resource sources.
3. Tests:
   - `test/component/resource-overlay.test.ts` — overlay contributes from local + remote sources.
   - `test/component/resource-none-mode.test.ts` — tmpdir created and removed; pi tools target tmpdir.

**Acceptance**: All three modes work and are testable. Tmpdir cleanup is reliable across SIGINT, SIGTERM, and `connection.closed`.

### Phase 8 — Diagnostics + release

1. `src/resources/diagnostics.ts` — formatter + emit logic.
2. Wire emission into `PiAcpSession.prompt` (first prompt only; flag tracked on session).
3. README updates:
   - Manifest format reference.
   - `import_resource` tool documentation.
   - Cwd modes table.
   - ACP-FS delegation behavior.
4. CHANGELOG `v0.6.0` section.
5. Bump version, tag, semantic-release does the rest.
6. Post-release issues:
   - Zed Remote smoke test follow-up (validate ACP-FS routing).
   - Persistent disk cache for HTTP sources (v0.7?).
   - Remote bash / write semantics (v0.7+ design exploration).

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pi `ResourceLoader` interface drifts in a future pi minor | Med | High | Pin pi minor in `package.json`. CI runs component tests; drift surfaces at upgrade. ADR-0006 records the contract version. |
| `extendResources()` does not work mid-session | Med | Med | Verify in Phase 6 (Q1). If not, scope `import_resource` to stage imports for the next prompt cycle and document. |
| SSH backend hangs on stale ControlMaster sockets | High | Med | Hard 5s timeout per op. Source marked failed on timeout; session proceeds. |
| YAML manifest parse errors confuse users | Med | Low | Zod surfaces specific field-level errors as diagnostics. Document the schema. |
| ACP-FS delegation routes to wrong host on some clients | Med | Med | Test against Zed Remote specifically. Document the behavior expected from clients. Surface error on first failed delegation. |
| `none` mode tmpdir leaks on crash | Low | Low | OS reaps `os.tmpdir()` over time. Document. |
| `import_resource` validation accepts malformed skills | Low | Med | Validate `SKILL.md` + frontmatter parseable. Reject otherwise with structured error. |
| Manifest cascade produces surprising overrides | Med | Med | `diagnostics: true` shows effective manifest at session start. Document precedence prominently. |

## Open Questions

- Q1 (PRD-002): Does `resourceLoader.extendResources()` work mid-session, or only at session start? Resolve in Phase 6.
- Q2 (PRD-002): `~/.pi-acp/config.yaml` vs XDG `~/.config/pi-acp/config.yaml`? Decide in Phase 2 — lean `~/.pi-acp/` for symmetry with `~/.pi/`.
- Q3 (PRD-002): SSH ControlMaster reuse — per-session or per-operation? Start per-operation; profile later.
- Q4 (PRD-002): `import_resource` results cached on disk for resume-session? Refetch by default in v0.6; persistent cache in v0.7+.
- Q5 (PRD-002): Does Zed Remote delegate `fs/read_text_file` to the remote machine or the local FS? Verify via dev-box smoke in Phase 5.
- Q6 (PRD-002): `none` mode tmpdir as real `os.tmpdir()` or memfs? Real tmpdir — pi extensions reading `cwd()` need it.
- Q7 (PRD-002): New client-side capability for manifest-aware clients? Probably no — manifest is server-side config.
- Q8 (PRD-002): `import_resource` interaction with pi's resource auto-reload? Verify in Phase 6.

## ADR Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-0006](../adr/ADR-0006-virtual-resource-loader.md) | Custom VirtualResourceLoader for Multi-Root Resource Composition | Accepted |
| [ADR-0007](../adr/ADR-0007-acp-fs-delegation.md) | Delegate read Tool to ACP Client When fs.readTextFile Capability Advertised | Accepted |
| [ADR-0008](../adr/ADR-0008-resource-composition-manifest.md) | Resource Composition Manifest | Accepted |
| [ADR-0009](../adr/ADR-0009-cwd-independence-modes.md) | Cwd Independence Modes | Accepted |
