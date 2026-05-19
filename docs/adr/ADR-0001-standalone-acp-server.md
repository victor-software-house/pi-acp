---
title: "pi-acp is a Standalone ACP Server, Not a Pi Extension"
adr: ADR-0001
status: Accepted
date: 2026-05-18
prd: "docs/prd/PRD-001-acp-v013-zed-alignment.md"
decision: "Standalone bin built on top of pi SDK"
---

# ADR-0001: pi-acp is a Standalone ACP Server, Not a Pi Extension

## Status

Accepted — codifies the shape already shipping in `v0.4.0`.

## Date

2026-05-18

## Requirement Source

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md`
- **Decision Point**: Scope item 9 (docs migration) requires explicit recording of the standalone-server shape; PRD §4 Out-of-scope assumes this shape but no prior ADR documents it.

## Context

Pi exposes two integration surfaces:

1. **Extensions** — TypeScript modules loaded into a running pi process. Authored against `ExtensionAPI` from `@earendil-works/pi-coding-agent`. Live in `~/.pi/agent/extensions/` or shipped as packages with `pi.extensions` manifest entries. Hot-reloadable via `/reload`. Cannot run without a pi host process.

2. **SDK** — public exports from `@earendil-works/pi-coding-agent` (`createAgentSession`, `SessionManager`, `AgentSession`, `ModelRegistry`, `AuthStorage`). Programmatic access to pi's agent core. Embeddable in any Node/Bun process. Pi's own RPC mode (`pi --mode rpc`) is the reference standalone consumer.

ACP (Agent Client Protocol) is a JSON-RPC protocol that a client (typically an editor like Zed) speaks to an agent process over stdio. The agent process is launched by the client via configuration like Zed's `agent_servers.<name>.command + args`. The agent is expected to:

- Exit cleanly when the client closes stdin.
- Write only ACP JSON-RPC frames to stdout.
- Own its own session lifecycle, authentication state, and configuration.

These constraints are inherently incompatible with pi's extension model:

- Extensions cannot own the process lifecycle — pi owns it.
- Extensions share stdout with the pi TUI — incompatible with ACP's clean-stdout requirement.
- Extensions register slash commands and tools inside pi's prompt loop — ACP is a separate protocol surface, not an in-process command.
- An ACP-as-extension would still require a wrapper bin to be invokable by Zed, which is what the standalone server *is*.

The fork at `v0.4.0` already implements pi-acp as a standalone bin (`bin: { "pi-acp": "dist/index.mjs" }`) built on top of pi SDK. This ADR documents that the standalone shape is the correct shape and will not regress into the extension model.

## Decision Drivers

- ACP launches the agent as a child process with stdio piped — extensions cannot satisfy this.
- ACP requires clean stdout — pi's TUI uses stdout; extensions inherit that.
- Zed's `agent_servers` config consumes a `command + args` pair that points at a binary, not at an extension manifest.
- Pi's SDK is explicitly designed for embedding (`createAgentSession` is the documented integration entry point).
- The reference Zed ACP adapters (`claude-agent-acp`, `codex-acp`) are also standalone bins, not extensions of their respective agents.

## Considered Options

### Option 1: Pi extension wrapping ACP

Implement pi-acp as a pi extension that opens an ACP transport (stdio or socket) when loaded.

- Good, because hot-reload via `/reload` would simplify development.
- Bad, because pi owns stdout via the TUI — ACP frames would collide with pi's render output.
- Bad, because Zed cannot launch a pi extension directly; it would need a wrapper bin anyway.
- Bad, because the extension would need to bootstrap a full pi session inside an already-running pi session, doubling the agent state.
- Bad, because pi extensions cannot guarantee the "exit on stdin EOF" behavior ACP clients rely on.

### Option 2: Standalone bin built on pi SDK (chosen)

Implement pi-acp as a standalone Node/Bun bin. Import `createAgentSession`, `SessionManager` from `@earendil-works/pi-coding-agent`. Translate between ACP wire format and pi agent events. Bin entry runs `AgentSideConnection + ndJsonStream` over `process.stdin` / `process.stdout`.

- Good, because Zed launches it directly via `agent_servers.<name>.command`.
- Good, because stdout discipline is enforceable (we own the process).
- Good, because process lifecycle is controllable (signal handlers, `connection.closed.then(shutdown)`).
- Good, because matches the reference ACP adapters (`claude-agent-acp`, `codex-acp`).
- Good, because pi's SDK is the documented embedding surface — no private API risk.
- Bad, because requires shipping a bin (more publish complexity than an extension).
- Neutral, because development workflow is `bun run dev` + manual ACP client; no hot-reload like extensions, but the surface area is small enough to make this acceptable.

### Option 3: HTTP/socket transport instead of stdio

Same as Option 2 but over a TCP/Unix socket rather than stdio.

- Good, because allows multiple clients to share a single pi-acp instance.
- Bad, because ACP wire compat assumes stdio in practice; no current client (Zed, JetBrains, neovim plugins) uses socket transport.
- Bad, because introduces port/auth coordination not present in the stdio model.
- Deferred, but not chosen now. Could be added later as an alternate entry point without invalidating Option 2.

## Decision

Chosen option: **"Standalone bin built on pi SDK"**, because Zed and other ACP clients launch agents as child processes over stdio, pi extensions cannot satisfy that contract, and pi's SDK is the right embedding surface. The fork already ships this shape — this ADR codifies it as permanent rather than a transitional state.

## Consequences

### Positive

- pi-acp can be installed as a single `npm i -g @victor-software-house/pi-acp` (or equivalent) and pointed at from any ACP client's `agent_servers`-equivalent config.
- Process lifecycle, stdout discipline, and signal handling are first-class — no fighting pi's TUI for shared resources.
- Matches the reference ACP adapter shape used by Zed Industries, so contributors familiar with `claude-agent-acp` find pi-acp's structure immediately legible.
- Future transport options (HTTP, WebSocket, ACP-over-socket) can be added as alternate entry points without restructuring the agent core.

### Negative

- No hot-reload during development. Mitigation: pi-acp's surface area is small (~3k LOC src/) and a `bun run dev` + manual ACP-client smoke loop is fast enough.
- Two artifacts to maintain if a pi extension is *also* desired for in-pi convenience features later. Mitigation: such an extension would be a thin shim, not a fork of the ACP server.

### Neutral

- The bin name (`pi-acp`) is now part of the stable API; renaming it would break every Zed user's `agent_servers` config. See PRD §8 D4.

## Related

- **PRD**: `docs/prd/PRD-001-acp-v013-zed-alignment.md`
- **Plan**: `docs/architecture/plan-acp-v013-zed-alignment.md`
- **Reference impl**: `agentclientprotocol/claude-agent-acp` (`src/index.ts` shows the canonical bin shape — stdout redirect to stderr, `connection.closed.then(shutdown)`).
- **Pi SDK docs**: `earendil-works/pi/packages/coding-agent/docs/sdk.md`.
- **ADRs**: Foundational. No predecessors.
