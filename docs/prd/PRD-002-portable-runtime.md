---
title: "pi-acp v0.6: Portable Runtime + Multi-Host Resource Composition"
prd: PRD-002
status: Draft
owner: "Victor Araujo"
issue: "N/A"
date: 2026-05-19
version: "1.0"
---

# PRD: pi-acp v0.6 — Portable Runtime + Multi-Host Resource Composition

---

## 1. Problem & Context

pi-acp `v0.5` ties an ACP session to one local working directory and one local filesystem:

- pi loads context (`AGENTS.md` / `CLAUDE.md` walk, skills, prompts, extensions, themes, system prompt overrides) from the session's `cwd` and the local `~/.pi/agent/` only — by way of pi's `DefaultResourceLoader`.
- Built-in tools (`read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`) operate directly on the local FS of whichever host runs `pi-acp`.
- The session can only function on a machine that already has all the right files in the right local paths.

Three real-world scenarios break:

1. **"Run pi-acp from anywhere."** User has pi-acp on their laptop. Project lives on a dev VM over SSH, or in a container, or on a tagged sub-tree of a different machine. Today: clone the project locally, duplicate config files, accept that pi sees a stale snapshot.
2. **"Import resources from another host."** User maintains skills/prompts/extensions/`AGENTS.md` on host A (`cvm`, a dev VM with shared team config). Wants those same resources surfaced when pi-acp runs on host B (laptop). Today: must `rsync`/`scp` or symlink. Every host drift breaks pi-acp.
3. **"Multi-root context."** Project actually spans two repos — for example `~/workspace/frontend` and `~/workspace/backend` — or the user wants to pull in a corporate `AGENTS.md` repo as additional read-only context. Today: pi walks a single cwd chain; the second root is invisible.

These are not theoretical. They are the daily experience of working on contractor laptops, jump hosts, OrbStack VMs, and Zed Remote sessions.

### What is explicitly NOT the problem

- pi does not ask for permission before tool execution, and adding ACP `session/request_permission` would require forking pi. **Not in scope.**
- pi has no `agent_plan` surface. **Not in scope.**
- ACP `terminal/*` delegation requires pi to delegate command execution, which it does not. **Not in scope.**

This PRD is **not** about granting external control over pi's safety model. It is about decoupling **where pi-acp runs** from **where its inputs come from**.

### Relationship to PRD-003 (runtime daemon)

PRD-002 and PRD-003 ship together in v0.6. PRD-003 introduces a long-running daemon + thin-client split (ADR-0010); PRD-002's backends (`VirtualResourceLoader`, `SshPool`, `HttpCache`, `ManifestCache`) plug into the daemon's shared-singleton context (`DaemonContext`) so caches and connections are shared across all ACP clients connected to the daemon. PRD-002 phases re-sequence to land **after** PRD-003 Phase 1 (daemon skeleton) is in place. PRD-002 implementation is otherwise architecturally identical — the backends are pure classes; the daemon is the host.

### What pi already exposes that makes this tractable

The pi `0.75` SDK is unusually well-factored for the work this PRD wants to do:

- `createAgentSession({ resourceLoader })` accepts a fully custom implementation of pi's `ResourceLoader` interface. The interface is small (8 methods, all `get*`/`reload`/`extendResources`) and stable as of pi `0.75`.
- `createAgentSession({ customTools })` accepts arbitrary `ToolDefinition`s that show up alongside built-ins.
- `createAgentSession({ tools: ["bash"] })` allowlists which built-ins are enabled; the missing ones can be replaced by `customTools` implementations.
- `createAgentSession({ sessionManager })` accepts a custom `SessionManager` so session storage location is not locked to `~/.pi/agent/sessions/`.
- `createAgentSession({ agentDir })` redirects "global" pi resources off the default `~/.pi/agent` path.

The leverage is in pi-acp wrapping these primitives, not in patching pi.

---

## 2. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| **Run from anywhere** | pi-acp accepts a session with cwd `local` / `overlay` / `none` modes | All three modes work; component test per mode |
| **Multi-host resource composition** | Resource discovery aggregates across multiple sources of mixed kind | Demo: local cwd + SSH host + HTTP URL contribute simultaneously |
| **ACP-FS delegation** | When client advertises `fs.readTextFile`, `read` tool delegates to ACP client | Verified end-to-end against Zed (or recorded fixture) |
| **Declarative discovery control** | `.pi-acp.yaml` manifest at project, user-global, or session-param scope | Schema documented; cascade resolver tested |
| **On-demand resource pulls** | Agent can call `import_resource({ source, kind, path })` mid-session | Custom tool reachable from any model |
| **Backwards compat** | No manifest → behavior identical to v0.5 | Existing tests pass with no changes |
| **No pi fork** | All wiring via pi's public SDK | No patches to `node_modules/@earendil-works/*` |

**Guardrails (must not regress):**

- v0.5 reactive auth path stays identical.
- Existing test surface (186 tests) passes unmodified — new tests are additive.
- Local-mode session start latency does not increase (no remote roundtrips when manifest absent).
- `_meta.piAcp.*` namespace stays as-is. New `_meta.piAcp.resources` keys may be added but existing keys keep their meaning.
- Bin shape (`pi-acp`), terminal-login flag, semantic-release pipeline untouched.

---

## 3. Users & Use Cases

### Primary: Workstation-anywhere user

> As a contractor whose laptop is the only constant across engagements, I want pi-acp to read skills + prompts + `AGENTS.md` from my personal config repo no matter which client project I am working on, and from the client's repo when I am inside that workspace, without manually merging them.

**Preconditions:** pi-acp installed locally; `.pi-acp.yaml` in repo root declares the two sources.

### Primary: SSH-remote project user

> As a user whose project lives on `cvm` (a remote dev VM), I want to run pi-acp on my laptop, have it discover my dotfile-managed skills (which live on the laptop), and have `read` calls land on `cvm`'s filesystem (which is what I am actually editing in Zed Remote).

**Preconditions:** ACP client (Zed) advertises `clientCapabilities.fs.readTextFile`; pi-acp manifest declares an `acp-fs` source for project files.

### Primary: Multi-root project user

> As a developer working on `frontend` + `backend` together, I want pi to see both `AGENTS.md` files and both repos' `.pi/prompts/` so `/refactor-foo-component` from frontend and `/regenerate-migrations` from backend are both available in the same session.

**Preconditions:** Manifest declares two `local` roots with `mergeStrategy: append`.

### Secondary: One-shot Q&A user (no cwd)

> As a user asking a one-shot question that has nothing to do with any project ("explain ECMAScript modules"), I want pi-acp to spin up a session without forcing a cwd, without polluting any real directory with `.pi/` state.

**Preconditions:** Manifest `mode: none`, or ACP session param override.

### Secondary: Shared team-context user

> As a maintainer of a team's shared `AGENTS.md` (hosted in a public repo), I want every contributor's pi-acp to auto-include the latest version at session start, with a 5-minute cache.

**Preconditions:** `kind: http` source with HTTPS URL; manifest committed to the team repo.

---

## 4. Scope

### In scope (v0.6)

1. **`VirtualResourceLoader`** — custom implementation of pi's `ResourceLoader` interface that composes from multiple `ResourceSource` instances.
2. **`ResourceSource` backends:** `local`, `acp-fs`, `ssh`, `http`. (Read-only for `ssh` and `http`. Local stays writable as today.)
3. **Resource composition manifest** (`.pi-acp.yaml`) at three cascade levels: ACP session-param override > project (`<cwd>/.pi-acp.yaml`) > user-global (`~/.pi-acp/config.yaml`) > synthesized default.
4. **`import_resource` custom tool** registered via `customTools`. On-demand fetch + injection via `resourceLoader.extendResources()`.
5. **Cwd-independence modes:**
   - `local` (default, v0.5 behavior)
   - `overlay` (primary cwd + read-only aux roots contribute resources)
   - `none` (ephemeral tmpdir; useful for cwd-less sessions)
6. **ACP-FS delegation for `read` tool** when client advertises support — pi's built-in `read` is disabled and replaced by a custom tool that proxies to `connection.fs.readTextFile`.
7. **Diagnostics surface** — opt-in one-line summary per source contribution at session start; failed sources surface as `[failed]` with a reason.

### Out of scope / deferred

| What | Why | Deferred to |
|------|-----|-------------|
| Per-tool permission gates / `session/request_permission` | Pi handles permissions internally; adding gates needs a pi fork. | Won't fix at pi-acp layer |
| `agent_plan` updates | Pi has no plan surface. | Won't fix at pi-acp layer |
| Remote `bash` (run commands on SSH host) | Different blast radius from remote `read`; needs review/staging semantics. | v0.7+ if demand |
| Remote `edit` / `write` (write back to SSH host) | Same as remote bash; write needs conflict + dry-run. | v0.7+ if demand |
| ACP `terminal/*` delegation | Pi runs commands locally; same blast radius problem as remote bash. | v0.7+ if demand |
| Live remote-FS watch / file events | Manifest snapshot + `import_resource` covers v0.6 needs. | v0.7+ if demand |
| Persistent disk cache for HTTP sources | Per-session cache is enough for v0.6. | v0.7+ if profile shows cost |
| MCP server wiring per session | Still blocked on pi SDK. | Future PRD when pi unblocks |
| Status surfacing for auto-retry / auto-compaction (FR-6 from PRD-001) | ACP still has no first-class status channel. | When ACP gains a notification primitive |

### Design for future (build with awareness)

- The `ResourceSource` backend interface should leave room for `kind: "container"` (read from a running container's FS) and `kind: "git-rev"` (read from a specific commit without checkout). Don't design those in v0.6, but don't paint into a corner.
- The `import_resource` tool should record its imports in a session-scoped audit log; the log is not a v0.6 surface but the storage shape should support it.

---

## 5. Functional Requirements

### FR-1: `VirtualResourceLoader`

Replace `DefaultResourceLoader` with `VirtualResourceLoader` that satisfies pi's `ResourceLoader` interface:

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

`VirtualResourceLoader` composes from an ordered list of `ResourceSource` instances. On `reload()`, every source's `reload()` runs in parallel with per-source timeout. Each accessor aggregates contributions across sources per the configured `mergeStrategy`.

**Acceptance criteria:**

```gherkin
Given a manifest with two `local` sources at distinct paths
When VirtualResourceLoader.getSkills() is called
Then the result contains skills from both sources
And duplicate skill names are resolved per the mergeStrategy

Given a manifest with a `local` source plus an `ssh` source that times out
When VirtualResourceLoader.reload() runs
Then the local source contributes normally
And the ssh source's diagnostics include a timeout reason
And the overall reload resolves without throwing
```

### FR-2: `ResourceSource` backends

Each backend implements:

```ts
interface ResourceSource {
  readonly id: string;
  readonly kind: "local" | "acp-fs" | "ssh" | "http";
  reload(): Promise<void>;
  getAgentsFiles(): Array<{ path: string; content: string }>;
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
  getExtensions(): LoadExtensionsResult;
  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
  readFile(relativePath: string): Promise<string | null>;
}
```

- **`LocalBackend`** — wraps `DefaultResourceLoader` semantics for one root. No remote calls. Reuses pi's existing `loadSkills`, `loadProjectContextFiles` helpers where possible.
- **`AcpFsBackend`** — delegates reads through the bound `AgentSideConnection.fs.readTextFile({ path })`. Only enabled if `clientCapabilities.fs.readTextFile === true`. Supports listing through a manifest-declared file list (the ACP spec does not currently expose `fs/listDir`).
- **`SshBackend`** — invokes a uv-shebanged Python helper (`scripts/ssh-cat.py`) via Bun Shell `$`. The helper wraps the system `ssh` binary with `subprocess.run(timeout=...)` so the wall-clock timeout lives at the shell layer (where the bun-shell skill says it should), AND passes `-o BatchMode=yes -o ConnectTimeout=N -o ServerAliveInterval=2 -o ServerAliveCountMax=N` so ssh self-terminates on a stalled remote without any caller-side `killSignal` machinery. Honors user's `~/.ssh/config` (ProxyJump, ControlMaster, agent forwarding). Helper has PEP 723 inline metadata + zero Python deps; macOS does not ship coreutils' `timeout(1)`, so the uv-shebanged Python path is the cross-platform answer. Phase 6 scope: AGENTS files via explicit `paths.agentsFiles` list only; skills / prompts / extensions over SSH stay deferred and surface one diagnostic per declared kind. Tool-selection rule: Bun Shell `$` for the runtime command pipeline (auto-escaped interpolation); uv-shebanged Python helpers when `$` itself cannot do the job (timeouts, signal-handling, rich argparse). Reserve `Bun.spawn` for cases needing IPC, AbortSignal-driven cancel, FileSink incremental stdin, or `maxBuffer`. Never `child_process.spawn`.
- **`HttpBackend`** — HTTPS-only `fetch`. Supports GitHub raw URLs, gist content, public CDN. Per-source `cache.ttl` in seconds (default 300). No write semantics.

**Acceptance criteria:**

```gherkin
Given an `acp-fs` source bound to a client that advertises fs.readTextFile
When VirtualResourceLoader.readFile("src/foo.ts") is called via that source
Then the call routes through connection.fs.readTextFile({ path: "src/foo.ts" })

Given an `ssh` source with host "cvm" and user "varaujo"
When VirtualResourceLoader.readFile("AGENTS.md") is called via that source
Then a child ssh process runs `ssh varaujo@cvm cat <expanded-path>`
And the stdout is returned as the file content
And a 5-second timeout aborts with a diagnostic

Given an `http` source with baseUrl "https://raw.githubusercontent.com/..."
When VirtualResourceLoader.readFile("AGENTS.md") is called
Then an HTTPS GET hits baseUrl + "/AGENTS.md"
And the response body is returned on 2xx
And the response is cached for `ttl` seconds
```

### FR-3: Manifest format `.pi-acp.yaml`

```yaml
version: 1
mode: overlay   # local | overlay | none
roots:
  - id: local
    kind: local
    paths:
      cwd: .
      agentDir: ~/.pi/agent

  - id: vsh-shared
    kind: ssh
    host: cvm
    user: varaujo
    paths:
      skills: /home/varaujo/.pi/agent/skills
      prompts: /home/varaujo/.pi/agent/prompts
      agentsFiles:
        - /home/varaujo/.config/agents/GLOBAL.md

  - id: team-context
    kind: http
    baseUrl: https://raw.githubusercontent.com/victor-software-house/context/main
    cache:
      ttl: 300
    paths:
      agentsFiles:
        - AGENTS.md
        - SECURITY.md

mergeStrategy: append   # append | override-by-name

auto-import:
  - source: team-context
    paths: ["AGENTS.md"]

diagnostics: false
```

**Cascade resolution** (highest precedence first):

1. ACP session params (`params._meta.piAcp.manifest` — full inline manifest or a path).
2. Project-level: `<cwd>/.pi-acp.yaml`.
3. User-global: `~/.pi-acp/config.yaml`.
4. Synthesized default: `{ version: 1, mode: "local", roots: [{ id: "local", kind: "local", paths: { cwd: ".", agentDir: "~/.pi/agent" } }], mergeStrategy: "append" }`.

Manifest schema validated with **Zod v4** at load time (`import * as z from 'zod'` — namespace import, never named). Always `safeParse()`, never `parse()`. Unknown keys surface as warning diagnostics, not fatal. `mode` is `z.enum(["local", "overlay", "none"])`; `mergeStrategy` is `z.enum(["append", "override-by-name"])`. See the `zod` and `typescript-type-safety` skills (latter for `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` interaction with optional schema fields, plus `ts-pattern` for exhaustive matching over the parsed manifest variant).

**Acceptance criteria:**

```gherkin
Given a project manifest declaring `mode: overlay` with two roots
And a user-global manifest declaring `mode: none`
When pi-acp opens a session for that project
Then the effective mode is `overlay` (project overrides user-global)
And both roots are active

Given an ACP session param `_meta.piAcp.manifest` carrying a full manifest
When pi-acp opens that session
Then the param manifest fully overrides both file-based manifests
```

### FR-4: `import_resource` custom tool

> **Mandatory skill**: `pi-tool-progressive-disclosure` — model-facing tool. Keep `description`, `promptSnippet`, parameter schema minimal. Prefer `StringEnum` over `anyOf`/`oneOf` for the `kind` argument. Tool stays inactive by default and is enabled via `pi.setActiveTools()` when a manifest declares at least one non-local source (avoids burning context when no remote sources exist). See also `pi-extension-writing` for `customTools` lifecycle.

Registered via `createAgentSession({ customTools: [importResourceTool] })`. Tool signature:

```ts
{
  name: "import_resource",
  description: "Fetch and inject a resource (skill, prompt, AGENTS.md, extension) from a configured manifest source into the active session.",
  arguments: {
    sourceId: string,    // matches a manifest root.id
    kind: "skill" | "prompt" | "agentsFile" | "extension" | "raw",
    path: string,        // relative to the source root
    alias?: string,      // optional name override
  }
}
```

On invocation:
1. Look up the `ResourceSource` for `sourceId`. 404 if not configured.
2. Call the kind-specific loader (`source.fetchSkill(path)`, `source.fetchPrompt(path)`, etc.).
3. Validate shape (skill = `SKILL.md` + sibling files; prompt = single `.md` with frontmatter).
4. Call `resourceLoader.extendResources({ skillPaths: [...] })` (or analogous kind path).
5. Return a one-line summary or a structured error.

**Acceptance criteria:**

```gherkin
Given a session with manifest source "vsh-shared" of kind ssh
When the agent invokes import_resource({ sourceId: "vsh-shared", kind: "skill", path: "git-commit-message" })
Then pi-acp fetches the skill files via ssh
And calls resourceLoader.extendResources({ skillPaths: [...] })
And the next session/update reflects the new available command

Given an import_resource call with sourceId that does not exist in the manifest
When the tool runs
Then it returns an error result with reason "source not configured"
And no state is mutated
```

### FR-5: Cwd-independence modes

| Mode | cwd handling | Tool target |
|------|--------------|-------------|
| `local` (default) | ACP `params.cwd` (must exist, must be absolute) | Local cwd |
| `overlay` | ACP `params.cwd` is primary; manifest aux roots are read-only resource contributors | Local cwd |
| `none` | pi-acp creates an ephemeral tmpdir under `os.tmpdir()/pi-acp-session-<id>/` and uses that as cwd | Tmpdir |

Mode selection: manifest `mode:` field; overrideable per-session via `params._meta.piAcp.mode`.

In `none` mode, the tmpdir is deleted on session close. Bash/read/edit/write tools still operate on that tmpdir; the user understands the cwd is ephemeral. AGENTS.md/skills/prompts come exclusively from manifest sources (the tmpdir has nothing in it).

**Acceptance criteria:**

```gherkin
Given a manifest with mode: "none" and one ssh source for skills
When pi-acp receives session/new
Then a tmpdir is created and pi runs against it
And resources come only from the ssh source
And on session/close the tmpdir is removed

Given a manifest with mode: "overlay" and a primary local cwd plus an http source
When pi-acp receives session/new with that cwd
Then pi tools target the local cwd
And resources come from local + http combined
```

### FR-6: ACP-FS delegation for `read` tool

> **Mandatory skill**: `pi-tool-progressive-disclosure` — replacing pi's built-in `read` with a customTool changes what the model sees. The override's `description` and parameter schema must match the built-in's surface area exactly (same name, same args) so the model is unaware of the indirection. See `pi-extension-writing` references on `custom-tools-and-tool-overrides.md` for the override contract.

When `clientCapabilities.fs.readTextFile === true`:

1. pi-acp passes `tools: ["bash", "edit", "write", "grep", "find", "ls"]` to `createAgentSession` (omits `read`).
2. pi-acp passes `customTools: [acpReadTool]` where `acpReadTool` has `name: "read"` and the same argument schema as pi's built-in.
3. `acpReadTool.execute({ path })` calls `connection.fs.readTextFile({ sessionId, path })` and returns the result.

Pi's runtime sees a normal `read` tool; the model is unaware of the indirection. Zed Remote transparently routes `fs.readTextFile` to the remote machine, so `read` lands on the remote FS.

When `clientCapabilities.fs.readTextFile !== true`: pi-acp falls back to pi's built-in `read` (today's behavior).

**Acceptance criteria:**

```gherkin
Given an ACP client advertising fs.readTextFile capability
When pi calls the read tool with { path: "src/index.ts" }
Then pi-acp issues an ACP fs/read_text_file request to the client
And the client's response body becomes the tool result

Given an ACP client without fs.readTextFile capability
When pi calls the read tool
Then pi's built-in read executes locally as today
```

### FR-7: Diagnostics surface

Opt-in via manifest `diagnostics: true`. At session start, after manifest evaluation and source reloads:

```
[pi-acp] resources active:
  local           cwd=. agentDir=~/.pi/agent (12 AGENTS files, 3 skills, 5 prompts)
  vsh-shared      ssh varaujo@cvm (8 skills, 2 prompts)
  team-context    https://raw.githubusercontent.com/... (1 AGENTS file)
[pi-acp] resource failures:
  team-context    AGENTS.md (HTTP 404)
```

Emitted as one or two `agent_message_chunk` updates at the start of the first prompt's response (chosen surface — it is at session boundary, not interleaved with model text).

**Acceptance criteria:**

```gherkin
Given a manifest with diagnostics: true and three sources, one failing
When the first prompt of the session is sent
Then before any model output, two agent_message_chunk updates are emitted
And the failing source is marked [failed] with the underlying reason
```

---

## 6. Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| **Latency (manifest absent)** | Identical to v0.5. No new I/O. |
| **Latency (manifest present)** | Session creation completes in <2s for ≤5 sources, ≤50 files per source. All source reloads run in parallel. |
| **Failure mode** | A single source failing (timeout, auth, missing path) must NOT block session creation. Failure surfaces as a diagnostic; the rest of the session proceeds. |
| **Backwards compat** | No manifest → identical to v0.5. No new ACP wire surface unless client opts in. Existing test suite (186 tests) passes unmodified. |
| **Security: SSH** | Uses system `ssh`. No private key handling inside pi-acp. User's existing `~/.ssh/config`, agent socket, ProxyJump, and ControlMaster apply. |
| **Security: HTTP** | HTTPS-only. No `http://`. No authorization headers in v0.6 (would need secret handling). |
| **Security: ACP-FS** | Trust model identical to v0.5 — client already sees prompt text and tool calls; routing `read` through it does not expand the attack surface. |
| **Caching** | HTTP sources: per-source `cache.ttl` (default 300s, in-memory). SSH sources: per-session in-memory cache. No persistent disk cache. |
| **Test coverage** | One unit test per `ResourceSource` backend. One component test per FR-5 mode. One end-to-end fixture for FR-6 (ACP-FS delegation). |

---

## 7. Risks & Assumptions

### Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Pi `ResourceLoader` interface drifts in a future pi minor and `VirtualResourceLoader` no longer satisfies it | High | Med | Pin pi minor. ADR-0006 records the contract version. Component tests catch shape drift at upgrade time. |
| SSH backend hangs session start when ControlMaster socket is stale | High | Med | Hard 5s timeout per `ssh` invocation. On timeout, source is marked failed and skipped. |
| HTTP backend caches stale `AGENTS.md` longer than user expects | Med | Med | TTL default 300s; documented; user can set lower in manifest. Add `import_resource(..., refresh: true)` for force-refetch (out of v0.6 scope; track for v0.7). |
| `import_resource` validation lets a malformed skill through | Med | Low | Validate skill = `SKILL.md` present + frontmatter parseable. Reject and return error if not. |
| Manifest cascade produces surprising overrides | Med | Low | `diagnostics: true` shows the effective manifest. Document precedence loudly. |
| ACP-FS delegation breaks for clients that "support" the capability but route to the wrong FS root | Med | Low | Test against Zed Remote specifically. Fall back to local `read` if the delegated call fails on first invocation (one-shot fallback). |
| `none` mode breaks pi extensions that assume a real cwd | Med | Med | `none` is opt-in. Document the breakage. Tmpdir is a real on-disk dir so `cwd()` returns a valid path. |
| YAML parse errors leave the user with no diagnostic | Low | Low | On parse error, fall back to synthesized default + emit a diagnostic chunk. |

### Assumptions

- Pi `0.75.3`'s `ResourceLoader` interface is stable through the v0.6 implementation window. To be re-verified during Phase 1.
- ACP `fs/read_text_file` semantics are stable in SDK `v0.22.1+`. Confirmed in current SDK source.
- Zed Remote routes `fs/read_text_file` to the remote machine's FS, not the host laptop's FS. To be verified via dev-box smoke before committing to FR-6 as the headline feature.
- `child_process.spawn("ssh", ...)` works on all target platforms (macOS, Linux). Windows is best-effort — users can fall back to WSL or skip SSH sources.
- `~/.pi-acp/` is acceptable as the user-global config directory. (Alternatives: `~/.config/pi-acp/` — XDG-compliant. Choose during Phase 2.)

---

## 8. Design Decisions

### D1: Custom ResourceLoader vs fork pi

**Options:**
1. Patch pi to add multi-root support to `DefaultResourceLoader`.
2. Implement `VirtualResourceLoader` as a custom pi-acp class that satisfies pi's interface.

**Decision:** Custom `VirtualResourceLoader`. ADR-0006.

**Rationale:** Pi exposes a clean, narrow `ResourceLoader` interface. Implementing it externally is mechanical, version-locked, and avoids the long-term cost of carrying a pi fork. The interface is the contract.

### D2: Backend selection per source vs per kind

**Options:**
1. Each source has one backend kind (`local` | `acp-fs` | `ssh` | `http`).
2. Each source can mix kinds per resource type (skills from SSH, prompts from HTTP).

**Decision:** Option 1.

**Rationale:** Simpler mental model and simpler implementation. If a user wants mixed kinds, they declare multiple sources. No information lost.

### D3: SSH backend uses system `ssh`, not in-process SFTP

**Options:**
1. `ssh2-sftp-client` npm dep for in-process file transfer.
2. `child_process.spawn("ssh", ...)` for everything.

**Decision:** Option 2. ADR-0007 covers ACP-FS, but the rationale carries over.

**Rationale:** No npm dep, no private-key handling inside pi-acp, no parallel TLS/SSH stack. Inherits user's existing `~/.ssh/config` and 1Password agent setup transparently. Tradeoff: ssh subprocess startup adds ~100ms per call; mitigated by per-session ControlMaster auto-share (left to user's ssh_config).

### D4: Read-only remote in v0.6

**Options:**
1. Make `ssh` and `acp-fs` writable too.
2. Read-only for remote backends; local stays writable.

**Decision:** Option 2.

**Rationale:** Remote writes need staging, conflict detection, dry-run, and user confirmation. None of those exist in pi today, and adding them inside pi-acp would re-invent `session/request_permission` poorly. Defer to v0.7+ with proper design.

### D5: ACP-FS delegation opt-in via client capability

**Options:**
1. Always delegate `read` through ACP if connected.
2. Delegate only when `clientCapabilities.fs.readTextFile === true`.

**Decision:** Option 2. ADR-0007.

**Rationale:** Spec-correct (capability gating is what `clientCapabilities` is for). Clients without the capability fall back to local-`read` cleanly. No surprise routing for non-fs-capable clients.

### D6: Manifest format YAML, not JSON or TOML

**Options:**
1. JSON (machine-friendly, but no comments).
2. TOML (comment-friendly, but less common in JS ecosystem).
3. YAML (comment-friendly, conventional for config in JS/TS world).

**Decision:** YAML. ADR-0008.

**Rationale:** Comments are essential for a config file that has cascade and merge semantics. JS ecosystem reaches for YAML by default. The implementation cost is one dep (`yaml`).

### D7: Manifest filename `.pi-acp.yaml`

**Options:**
1. `.pi-acp.yaml` (matches `.pi/` convention, hidden file).
2. `pi-acp.config.yaml` (visible, Webpack-style).
3. `.config/pi-acp.yaml` (XDG-like inside repo).

**Decision:** `.pi-acp.yaml`. ADR-0008.

**Rationale:** Project repos already have many dotfiles; one more is invisible noise. Matches the `.pi/` convention pi itself uses for project-local config.

### D8: Cwd modes are explicit enum, not flags

**Options:**
1. Boolean flags: `cwdRequired: true/false`, `multiRoot: true/false`.
2. Explicit enum: `mode: local | overlay | none`.

**Decision:** Enum. ADR-0009.

**Rationale:** Three modes, mutually exclusive, with clear semantics each. Flags would multiply states and create ambiguous combinations.

---

## 9. File Breakdown

| File | Change | FR |
|------|--------|-----|
| `src/resources/loader.ts` | New | FR-1 — `VirtualResourceLoader` |
| `src/resources/sources/base.ts` | New | FR-2 — `ResourceSource` interface |
| `src/resources/sources/local.ts` | New | FR-2 — `LocalBackend` |
| `src/resources/sources/acp-fs.ts` | New | FR-2, FR-6 — `AcpFsBackend` |
| `src/resources/sources/ssh.ts` | New | FR-2 — `SshBackend` |
| `src/resources/sources/http.ts` | New | FR-2 — `HttpBackend` |
| `src/resources/manifest.ts` | New | FR-3 — cascade resolver |
| `src/resources/manifest.schema.ts` | New | FR-3 — Zod schema |
| `src/resources/tools/import-resource.ts` | New | FR-4 |
| `src/resources/tools/acp-read.ts` | New | FR-6 |
| `src/resources/modes.ts` | New | FR-5 — mode handlers + tmpdir lifecycle |
| `src/resources/diagnostics.ts` | New | FR-7 |
| `src/acp/agent.ts` | Modify | Wires manifest → loader → `createAgentSession` |
| `src/acp/session.ts` | Modify | Emits resource diagnostics if opted in; tmpdir cleanup on close |
| `test/unit/resources/manifest.test.ts` | New | FR-3 |
| `test/unit/resources/sources-local.test.ts` | New | FR-2 |
| `test/unit/resources/sources-acp-fs.test.ts` | New | FR-2, FR-6 |
| `test/unit/resources/sources-ssh.test.ts` | New | FR-2 |
| `test/unit/resources/sources-http.test.ts` | New | FR-2 |
| `test/unit/resources/import-resource.test.ts` | New | FR-4 |
| `test/component/resource-overlay.test.ts` | New | FR-5 |
| `test/component/resource-none-mode.test.ts` | New | FR-5 |
| `test/component/acp-fs-delegation.test.ts` | New | FR-6 |
| `docs/adr/ADR-0006-virtual-resource-loader.md` | New | — |
| `docs/adr/ADR-0007-acp-fs-delegation.md` | New | — |
| `docs/adr/ADR-0008-resource-composition-manifest.md` | New | — |
| `docs/adr/ADR-0009-cwd-independence-modes.md` | New | — |
| `docs/architecture/plan-portable-runtime.md` | New | — |
| `README.md` | Modify | Document manifest, `import_resource`, cwd modes |
| `CHANGELOG.md` | Modify | `v0.6.0` section |
| `package.json` | Modify | Add `yaml` dep |

---

## 10. Dependencies & Constraints

- pi `@earendil-works/pi-coding-agent@^0.75.3` (or newer; `ResourceLoader` interface stable).
- ACP SDK `@agentclientprotocol/sdk@^0.22.1` (uses `connection.fs.readTextFile`; `clientCapabilities.fs.readTextFile`).
- New runtime dep: `yaml@^2.x` for manifest parsing.
- No fork of pi.
- No new network protocol — `ssh` via subprocess; HTTPS via `fetch`.
- Engines stay at `>=24`.

---

## 11. Rollout Plan

Phased, behind manifest opt-in throughout. Each phase is one PR. Plan file (`docs/architecture/plan-portable-runtime.md`) has the per-phase detail. Phases re-numbered to align with the PRD-003 daemon-foundation work that shipped alongside.

1. **Phase 0** — This PRD + ADR-0006..0009 + plan. No code.
2. **Phase 4** — `VirtualResourceLoader` + `LocalBackend` only. Behavior identical to v0.5 with no manifest. Existing tests pass unmodified. *(Shipped — was originally numbered Phase 1.)*
3. **Phase 5** — Manifest parser + cascade resolver + Zod schema. Tests with example manifests. *(Shipped — was originally numbered Phase 2.)*
4. **Phase 6** — `SshBackend`. Tests against fake-ssh fixture (no real network). *(Shipped — AGENTS files via paths.agentsFiles only; skills/prompts/extensions over SSH stay deferred and surface diagnostics.)*
5. **Phase 7** — `HttpBackend`. Tests with fixture HTTPS server.
6. **Phase 8** — `AcpFsBackend` + FR-6 `read` delegation. Integration test against fake ACP client.
7. **Phase 9** — `import_resource` custom tool. Tests with synthetic source.
8. **Phase 10** — Cwd-independence modes (`overlay`, `none`). Component tests.
9. **Phase 11** — Diagnostics surfacing + final docs. Cut `v0.6.0`.

Phases 6–7 can swap order. Phase 8 depends on Phases 4+5. Phase 9 depends on Phases 4+5.

---

## 12. Open Questions

| # | Question | Owner | Due | Status |
|---|----------|-------|-----|--------|
| Q1 | Does `resourceLoader.extendResources()` work mid-session, or only at session start? | Victor | Phase 6 | Open — verify in pi `0.75.3` source. |
| Q2 | Manifest file at `.pi-acp.yaml` or XDG-compliant `~/.config/pi-acp/config.yaml`? | Victor | Phase 2 | Open — leaning `.pi-acp.yaml` (project) + `~/.pi-acp/config.yaml` (user) for consistency with `.pi/` convention. |
| Q3 | SSH ControlMaster reuse — per-session or per-operation? | Victor | Phase 3 | Open — start per-operation; optimize if profiling shows cost. |
| Q4 | `import_resource` results cached on disk for resume-session, or refetched? | Victor | Phase 6 | Open — refetch by default in v0.6; persistent cache in v0.7. |
| Q5 | Does Zed Remote currently delegate `fs/read_text_file` to the remote machine, or to the local FS? | Victor | Phase 5 | Open — must verify via dev-box smoke before committing to FR-6 as the headline feature. If Zed routes to local, FR-6 is still useful (smaller benefit) but the user story shifts. |
| Q6 | Should the `none` mode tmpdir be a real `os.tmpdir()` subdir or a memfs? | Victor | Phase 7 | Open — leaning real tmpdir so pi extensions that read `cwd()` work. |
| Q7 | Does pi-acp need to advertise a new client-side capability (`_meta.piAcp.manifestSchemaVersion`) so clients can detect manifest support? | Victor | Phase 2 | Open — probably not for v0.6; manifest is server-side config, client doesn't need to know. |
| Q8 | How does `import_resource` interact with pi's own resource auto-reload behavior (file watchers)? | Victor | Phase 6 | Open — verify that `extendResources()` integrates with the resource invalidation path. |

---

## 13. Related

| Issue | Relationship |
|-------|-------------|
| PRD-001 v0.5 release | predecessor — `VirtualResourceLoader` slots in where `DefaultResourceLoader` was wired |
| `@earendil-works/pi-coding-agent@v0.75.3` | depends-on — `ResourceLoader` interface, `customTools`, `tools` allowlist, `agentDir`, `sessionManager` |
| `@agentclientprotocol/sdk@v0.22.1` | depends-on — `connection.fs.readTextFile`, `clientCapabilities.fs.readTextFile` |
| Zed Remote | smoke-target — FR-6 validation depends on Zed delegating `fs/*` correctly across the remote boundary |
| `victor-software-house/dotfiles` (chezmoi) | composition-pattern — the chezmoi tree is itself a multi-host resource composition; this PRD is the same problem at agent-resource granularity |

---

## 14. Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-05-19 | Initial draft (v1.0). | Victor |

---

## 15. Verification (Appendix)

Post-implementation checklist:

1. `bun test test/unit/resources/` — all green.
2. `bun test test/component/resource-overlay.test.ts` — overlay mode contributes from all sources.
3. `bun test test/component/resource-none-mode.test.ts` — `none` mode creates and cleans up tmpdir.
4. `bun test test/component/acp-fs-delegation.test.ts` — `read` tool routes through ACP when capability advertised.
5. With no manifest present: full v0.5 test suite (186 tests) passes unmodified.
6. Manifest with one SSH source pointing at `cvm`: skill list reflects `cvm`'s skills.
7. Manifest with one HTTP source pointing at a public GitHub raw URL: `AGENTS.md` content matches the file at that URL.
8. `import_resource` tool callable from a model session; returns success summary; subsequent `getSkills()` reflects the import.
9. `none` mode session: `os.tmpdir()/pi-acp-session-*/` exists during session; gone after session close.
10. Zed Remote dev-box: open a remote project; `read` tool calls land on the remote FS (verified by inspecting the file path returned).

---

## 16. Implementation Skill References

Skills under `~/.agents/skills/` (chezmoi-managed) and `~/.pi/agent/skills/` (pi agent) that MUST be loaded before working on the listed FRs. Skipping them is a process failure.

| FR | Skill | Why |
|---|---|---|
| FR-2 (`LocalBackend`) | `typescript-type-safety`, `zod` | Strict TS + Zod for any persisted shape; pi `DefaultResourceLoader` wrapping. |
| FR-2 (`SshBackend`) | `bun-shell`, `uv-python-cli` | Bun Shell `$` for the runtime command pipeline; `scripts/ssh-cat.py` uv-shebanged Python helper handles the timeout `$` cannot enforce (PEP 723 inline metadata, zero deps, stdlib subprocess). Reserve `Bun.spawn` for IPC / AbortSignal / FileSink stdin / maxBuffer. Never `child_process.spawn`. |
| FR-2 (`HttpBackend`) | `typescript-type-safety` | `Bun.fetch` + Zod-validated response envelopes. |
| FR-2 (`AcpFsBackend`) | `pi-extension-writing` (`custom-tools-and-tool-overrides.md`) | Backend bound to per-connection `AgentSideConnection`. |
| FR-3 (manifest) | `zod`, `typescript-type-safety` | Zod v4 namespace import, `safeParse`, `ts-pattern` for variant matching. |
| FR-4 (`import_resource`) | `pi-tool-progressive-disclosure`, `pi-extension-writing` | Mandatory for any new model-facing tool. `StringEnum`, minimal `promptSnippet`, `setActiveTools()` gating. |
| FR-5 (cwd modes) | `bun-shell` | `$\`mktemp -d ${tmpRoot}/pi-acp-session-XXXXXX\`` for `none`-mode tmpdir. |
| FR-6 (ACP-FS `read` override) | `pi-tool-progressive-disclosure`, `pi-extension-writing` | Tool-override contract — name + arg schema must mirror built-in `read` exactly. |
| FR-7 (diagnostics) | `pi-rendering-style`, `pi-footer-status` | Operator-visible surface; follow pi's renderer conventions. |
| All FRs (tests) | `linting-stack`, `lefthook-config` | Biome + oxlint (+ oxlint-zod plugin); pre-push runs full verify. |
| All FRs (release) | `greenfield-release` | Future migration to Changesets; current semantic-release path documented as legacy. |

Load skill via `/skill:<name>` before writing the code for that FR. Worktree-scoped reads stay loaded for the duration of that phase.
