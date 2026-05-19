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
- ~~Insurance: must remain possible to run v0.5 in-process mode if the daemon misbehaves.~~ *(Reversed during the foundation refactor — see "Update v1.1" below.)*

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

Concrete shape (current — see "Update v1.1" below for the post-refactor refinements):

- One daemon per UID. Sockets under `~/.pi/run/` (default; overridable via `PI_ACP_SOCKET_DIR`): `pi-acp.sock` for ACP NDJSON, `pi-acp-control.sock` for the Hono control plane, `pi-acp.lock` for the PID lockfile. Posix-only — Windows is unsupported.
- `pi-acp` with no flag = thin client. Tries to connect to the ACP socket; on failure, auto-spawns `pi-acp --daemon` detached, polls for socket, connects. Pipes stdio in both directions.
- `pi-acp --daemon` = the orchestrator. Holds `SessionRegistry`, `ResourceLoaderPool`, `SshPool`, `HttpCache`, `ManifestCache` as daemon-level singletons. Spawns one `AgentSideConnection` + `PiAcpAgent` per accepted socket connection, injecting the shared context.
- `pi-acp --terminal-login` = unchanged. Spawns pi directly in foreground. Never touches the daemon.
- `pi-acp --daemon-status` / `--daemon-stop` = operator commands. Speak HTTP over the dedicated control socket using a Hono app (`GET /status`, `POST /shutdown`, `GET /sessions`). Operator client uses `Bun.fetch` with the unix-socket option.
- Idle shutdown: daemon tracks active connection count. On count → 0, starts timer (`PI_ACP_DAEMON_IDLE_SECONDS`, default 600s). Timer fire → graceful shutdown. New connection cancels timer.
- Cross-window visibility: `session/list` returns union of sessions across all connected clients of the daemon, plus disk-persisted sessions. Each result carries `_meta.piAcp.ownedByThisConnection`.
- Crash isolation: per-connection `uncaughtException` handler — connection closes, daemon survives.

### Update v1.1 (foundation refactor, 2026-05-19)

Three v1.0 decisions reversed before any v0.6 phase shipped:

1. **No in-process escape hatch.** `PI_ACP_NO_DAEMON=1` / `--no-daemon` and `runtime/in-process.ts` were deleted. The "insurance" argument didn't survive — a daemon bug would also be hit by the in-process path since both share `PiAcpAgent`, so the second path was test-surface burden without a real recovery story.
2. **Operator commands on a dedicated control socket.** v1.0 had operator methods (`daemon/status`, `daemon/shutdown`) sniffed in-band on the ACP socket via first-frame peeking + `socket.unshift`. v1.1 splits them onto `~/.pi/run/pi-acp-control.sock` and serves them via Hono HTTP over UDS. The ACP socket is pure ACP — no peek, no unshift dance. Trivially debuggable: `curl --unix-socket ~/.pi/run/pi-acp-control.sock http://x/status`.
3. **Posix-only.** Windows named-pipe support was speculative and untested. Removed along with `process.platform === "win32"` branches across the codebase.

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
- Stale socket / lockfile handling adds edge-case logic that gets exercised rarely; bugs there surface only on user-machine crashes.

### Neutral

- Bin shape (`pi-acp`) preserved. Zed `agent_servers` configs do not change.
- ACP wire surface preserved — clients see normal NDJSON stdio frames from a normal-looking pi-acp process.
- `--terminal-login` unchanged. Documented to never engage daemon.

## Related

- **PRD**: `docs/prd/PRD-003-runtime-daemon.md`.
- **Plan**: `docs/architecture/plan-runtime-daemon.md`.
- **ADRs**: ADR-0001 (standalone server — daemon is the same bin, dispatched differently); ADR-0006..0009 (PRD-002 backends — beneficiaries of daemon's shared singletons).
- **Implementation skills** (`~/.agents/skills/` chezmoi-managed): `hono` (control plane), `bun-shell` (subprocess + tmpdir), `zod` + `typescript-type-safety` (schemas), `linting-stack`, `lefthook-config`, `greenfield-release`, `mise`. Canonical FR → skill mapping in PRD-003 §16. Skip them = process failure.
