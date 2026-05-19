---
title: "Delegate read Tool to ACP Client When fs.readTextFile Capability Advertised"
adr: ADR-0007
status: Accepted
date: 2026-05-19
prd: "docs/prd/PRD-002-portable-runtime.md"
decision: "Replace pi built-in read with a delegating custom tool when client supports fs.readTextFile"
---

# ADR-0007: Delegate read Tool to ACP Client When fs.readTextFile Capability Advertised

## Status

Accepted

## Date

2026-05-19

## Requirement Source

- **PRD**: `docs/prd/PRD-002-portable-runtime.md`
- **Decision Point**: FR-6 (ACP-FS delegation for `read` tool).

## Context

ACP `v0.13.2` defines `clientCapabilities.fs.readTextFile`. When the client advertises this capability, the agent (pi-acp) may issue `fs/read_text_file({ sessionId, path })` requests and the client returns the file content. The capability exists so the client can route reads through whatever filesystem it considers authoritative — its editor buffer (catching unsaved changes), a remote-mounted SSH filesystem, a container, or simply local disk.

Zed Remote is the canonical motivating case. When the user opens a project over Zed Remote:
- Project files live on the remote machine.
- The user's pi-acp instance may run locally (laptop) OR on the remote.
- If pi-acp runs locally and uses pi's built-in `read`, every `read("src/foo.ts")` lands on the **laptop** filesystem — wrong host.
- If pi-acp delegates `read` through `fs/read_text_file`, Zed Remote transparently routes the call to the remote machine — correct host.

Pi's built-in `read` tool is local-FS-only and has no hook to redirect through ACP. The SDK does, however, accept `customTools` via `createAgentSession`, and accepts a `tools` allowlist to disable specific built-ins.

## Decision Drivers

- Zed Remote is the primary scenario where pi-acp users want this to "just work."
- ACP spec defines the capability gate explicitly; using it is spec-correct, not invention.
- Pi exposes the necessary lever (`tools` + `customTools`).
- Non-ACP-FS-capable clients must keep working — delegation must be opt-in via capability.

## Considered Options

### Option 1: Always delegate `read` through ACP

- Good, because uniform behavior.
- Bad, because clients without `fs.readTextFile` would silently fail.
- Bad, because some clients explicitly route file access locally — overriding them is rude.

### Option 2: Delegate only when `clientCapabilities.fs.readTextFile === true` (chosen)

- Good, because spec-correct (the capability flag is what gates this surface).
- Good, because non-capable clients get unchanged v0.5 behavior.
- Good, because uniform code path: pi-acp's `initialize` handler already inspects `clientCapabilities` for other features (`terminal-auth`, `terminal_output`).
- Neutral, because adds a branch in `createAgentSession` wiring — small cost.

### Option 3: Add a user-facing manifest toggle to force delegation

- Good, because gives the user control.
- Bad, because confuses two concerns: capability advertisement (objective, from client) and user preference (subjective). The first is the right gate.
- Bad, because forcing delegation against a client that does not support it produces RPC errors with no recovery path.

### Option 4: Delegate `read` AND `write` AND `edit`

- Good, because uniform across file-touching tools.
- Bad, because write semantics need conflict detection / staging that ACP `fs/write_text_file` does not provide (no atomicity guarantees across multiple `read → modify → write` cycles).
- Bad, because write is fundamentally riskier than read; v0.6 explicitly scopes remote writes as deferred.

## Decision

Chosen option: **"Delegate `read` through ACP only when `clientCapabilities.fs.readTextFile === true`"**, because it is spec-correct, preserves backwards compatibility for non-capable clients, and matches pi-acp's existing capability-gated branches.

Wiring:

```ts
const fsReadDelegated = clientCapabilities.fs?.readTextFile === true;
const tools = fsReadDelegated
  ? ["bash", "edit", "write", "grep", "find", "ls"]
  : undefined; // pi defaults include read
const customTools = fsReadDelegated ? [acpReadTool] : [];
await createAgentSession({ ..., tools, customTools });
```

`acpReadTool.execute({ path })` calls `connection.fs.readTextFile({ sessionId, path })` and returns the result as a normal tool result.

## Consequences

### Positive

- Zed Remote users get correct-host reads with no manual configuration.
- Pi's `read` tool surface (description, schema, output shape) is preserved — the model is unaware of the indirection.
- v0.5 behavior preserved for any client without `fs.readTextFile`.

### Negative

- One more capability branch in `agent.ts`'s `newSession` (and `resumeSession`, `loadSession`).
- ACP `fs/read_text_file` does not currently support binary files; pi-acp must restrict `acp_read` to UTF-8 text. Pi's built-in `read` has the same restriction in practice (it reads files for the model, which only ingests text), so this is not a regression.
- The fallback path on delegated-read failure is not free — pi-acp must decide whether to retry locally or surface the ACP error. Initial choice: surface the ACP error. Local fallback would mask the routing intent and confuse the user.

### Neutral

- `edit`, `write`, and `bash` continue to use pi's built-ins (local execution). Users who want full remote execution wait for v0.7+ work (out of v0.6 scope).
- `grep`, `find`, `ls` stay local. These could theoretically delegate too, but ACP defines no equivalent primitives. Not a v0.6 problem.

## Related

- **PRD**: `docs/prd/PRD-002-portable-runtime.md` (FR-6).
- **Plan**: `docs/architecture/plan-portable-runtime.md` (Phase 5).
- **ACP spec**: `clientCapabilities.fs.readTextFile`, `fs/read_text_file` method.
- **SDK source**: `@agentclientprotocol/sdk@v0.22.1` — `acp.ts` `Client.fs.readTextFile`.
- **ADRs**: ADR-0006 (`VirtualResourceLoader` — depends-on; the `AcpFsBackend` reuses the delegation path for resource reads).
