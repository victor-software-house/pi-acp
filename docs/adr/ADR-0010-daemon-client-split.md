---
title: "Split pi-acp into Long-Running Daemon + Thin-Client Binary"
adr: ADR-0010
status: Accepted
date: 2026-05-19
prd: "docs/prd/PRD-003-runtime-daemon.md"
decision: "One daemon per UID; default bin is thin client that auto-spawns + forwards stdio"
---

# ADR-0010: Split pi-acp into Long-Running Daemon + Thin-Client Binary

## Status

Accepted

## Date

2026-05-19

## Requirement Source

- **PRD**: `docs/prd/PRD-003-runtime-daemon.md`
- **Decision Point**: Overall — how does pi-acp host multiple ACP sessions and share in-memory state across spawns.

## Context

`pi-acp` v0.5 is per-spawn: each ACP client launch instantiates a fresh Node process, loads pi from scratch, and dies when the client disconnects. Three concrete costs follow:

1. No cross-window visibility — sessions from one Zed window are invisible to another window's `session/list` because each window has its own pi-acp process.
2. Startup cost paid N times — ~200ms cold start per spawn.
3. PRD-002 backends (SSH ControlMaster, HTTP TTL cache, parsed manifests) cannot share in-memory state across spawns.

ACP itself is per-spawn by design — clients launch the agent via `agent_servers.<name>.command` and treat its lifetime as scoped to the connection. The spec does not contemplate a long-running orchestrator.

The question: how to keep the spawn surface intact (Zed still launches `pi-acp` via stdio) while sharing state across spawns.

## Decision Drivers

- Cross-window session visibility is the headline user-visible win.
- PRD-002 SSH / HTTP / manifest caches only pay off if shared.
- No client-side config changes (Zed `agent_servers` entries stay identical).
- `--terminal-login` must continue to work — pi's interactive auth flow is not daemonizable.
- Insurance: must remain possible to run v0.5 in-process mode if the daemon misbehaves.

## Considered Options

### Option 1: Status quo per-spawn

- Good, because no architectural change.
- Bad, because cross-window visibility impossible without filesystem polling.
- Bad, because PRD-002 backends cannot share in-memory state.

### Option 2: Filesystem-shared state only (no daemon process)

- Good, because no IPC machinery.
- Bad, because in-memory pools (SSH ControlMaster handles, HTTP cache, parsed manifests) cannot be expressed on disk without serialization cost that defeats the optimization.
- Bad, because session liveness state cannot be shared via files.

### Option 3: Long-running daemon + thin-client binary (chosen)

- Good, because in-memory state lives in one process and is shared by all clients.
- Good, because the spawn surface (`pi-acp` as the `command` Zed launches) is preserved — thin client forwards stdio to the daemon.
- Good, because `session/list` naturally returns the union across all connected clients.
- Good, because PRD-002 backends register their pools once and amortize.
- Neutral, because two binaries' worth of code paths (daemon + client) — but they share the same bin, dispatched on flag/env.
- Bad, because Pi 0.69 session-replacement context invalidation may not compose with multiple concurrent `AgentSession`s in one process. Mitigation: integration-test concurrent sessions in Phase 1 before declaring done; if it breaks, fall back to one-session-per-process daemon model with shared singletons but isolated session ownership.

### Option 4: Network daemon (TCP localhost)

- Good, because cross-machine reach (theoretically).
- Bad, because requires auth tokens, port allocation, firewall awareness — costs without one-machine-one-user benefits.

### Option 5: Daemon per project (not per UID)

- Good, because tighter isolation between projects.
- Bad, because users frequently work across projects in one window-set — cross-project `session/list` is the natural surface.
- Bad, because more daemons running = more memory.

## Decision

Chosen option: **Option 3 — long-running daemon + thin-client binary**.

Concrete shape:

- One daemon per UID. Socket at `${XDG_RUNTIME_DIR:-/tmp}/pi-acp-${UID}.sock` (Unix) or `\\.\pipe\pi-acp-${USERNAME}` (Windows).
- `pi-acp` with no flag = thin client. Tries to connect to socket; on failure, auto-spawns `pi-acp --daemon` detached, polls for socket, connects. Pipes stdio in both directions.
- `pi-acp --daemon` = the orchestrator. Holds `SessionRegistry`, `ResourceLoaderPool`, `SshPool`, `HttpCache`, `ManifestCache` as daemon-level singletons. Spawns one `AgentSideConnection` + `PiAcpAgent` per accepted socket connection, injecting the shared context.
- `pi-acp --terminal-login` = unchanged from v0.5. Spawns pi directly in foreground. Never touches the daemon.
- `pi-acp --daemon-status` / `--daemon-stop` = operator commands. Speak in-band on the socket via `daemon/status` / `daemon/shutdown` methods (namespaced to avoid ACP collision).
- `PI_ACP_NO_DAEMON=1` (or `--no-daemon` CLI flag) = escape hatch. Runs in-process v0.5 path, no socket activity. Stays functional as a regression-safety fallback indefinitely; CI runs full test suite in both modes.
- Idle shutdown: daemon tracks active connection count. On count → 0, starts timer (`PI_ACP_DAEMON_IDLE_SECONDS`, default 600s). Timer fire → graceful shutdown. New connection cancels timer.
- Cross-window visibility: `session/list` returns union of sessions across all connected clients of the daemon, plus disk-persisted sessions. Each result carries `_meta.piAcp.ownedByThisConnection`.
- Crash isolation: per-connection `uncaughtException` handler — connection closes, daemon survives.

## Consequences

### Positive

- Cross-window session visibility works without filesystem polling.
- PRD-002 backends share state — SSH ControlMaster reused across spawns, HTTP TTL cache hits across windows, manifest parsed once.
- Subsequent spawns cost <50ms (socket connect + ACP handshake) vs ~200ms cold.
- Memory footprint per session in line with v0.5; total memory bounded by one pi runtime + N sessions, not N pi runtimes.
- Operator visibility: `pi-acp --daemon-status` shows what's running.

### Negative

- Architectural complexity: socket transport, lockfile, auto-spawn, idle shutdown, crash isolation. Each is a tested component.
- Pi 0.69 concurrent-session safety not yet verified. Phase 1 integration test gates this; if unsafe, daemon falls back to one-`AgentSession`-per-process (one daemon spawns sub-processes per session).
- `PI_ACP_NO_DAEMON=1` is a second supported execution path — must stay green in CI alongside daemon mode. Doubles test surface for some integration tests.
- Stale socket / lockfile handling adds edge-case logic that gets exercised rarely; bugs there surface only on user-machine crashes.
- Windows named-pipe semantics differ enough from Unix sockets to warrant a Windows-CI lane.

### Neutral

- Bin shape (`pi-acp`) preserved. Zed `agent_servers` configs do not change.
- ACP wire surface preserved — clients see normal NDJSON stdio frames from a normal-looking pi-acp process.
- `--terminal-login` unchanged. Documented to never engage daemon.

## Related

- **PRD**: `docs/prd/PRD-003-runtime-daemon.md`.
- **Plan**: `docs/architecture/plan-runtime-daemon.md`.
- **ADRs**: ADR-0001 (standalone server — daemon is the same bin, dispatched differently); ADR-0006..0009 (PRD-002 backends — beneficiaries of daemon's shared singletons).
