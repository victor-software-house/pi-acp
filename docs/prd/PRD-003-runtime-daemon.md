---
title: "pi-acp v0.6: Long-Running Daemon + Thin-Client Binary"
prd: PRD-003
status: Draft
owner: "Victor Araujo"
issue: "N/A"
date: 2026-05-19
version: "1.0"
---

# PRD: pi-acp v0.6 — Long-Running Daemon + Thin-Client Binary

---

## 1. Problem & Context

pi-acp `v0.5` is a per-spawn ACP adapter: every time an ACP client (Zed window, CLI invocation, etc.) launches `pi-acp`, a fresh Node process is born, embedded pi initializes from scratch, and any in-memory state lives only for that connection's lifetime. When the connection closes, the process exits and all state is gone.

Three real costs land on the user:

1. **No cross-window session visibility.** Open Zed window A, start session, write 30 messages. Open Zed window B (same project or different) — `session/list` shows nothing from window A because A's process is a separate sandbox. Resume from disk works (pi persists sessions to `~/.pi/agent/sessions/`) but only via explicit session-id lookup; the natural "show me my active sessions" surface fails.
2. **Startup cost N times.** Each ACP client spawn = ~200ms of Node start + pi init + manifest evaluation (under PRD-002). For users who open many Zed windows or run pi-acp from a quick-action menu, this is felt.
3. **No in-memory cache sharing.** PRD-002 introduces SSH ControlMaster connections, HTTP TTL caches, parsed manifests, and per-cwd `VirtualResourceLoader` instances. With per-spawn pi-acp, every spawn rebuilds these. Multiple Zed windows for the same project pay the cost N times.

`v0.5` filesystem-backed state covers some of this:

- pi sessions persist to `~/.pi/agent/sessions/...` and are listable via `SessionManager.listAll()`.
- Auth state in `~/.pi/agent/auth.json`.
- Model registry in `~/.pi/agent/models.json`.

But filesystem-shared state cannot carry **in-memory connection pools, parsed-manifest caches, or live session handles**. Those are precisely the costs PRD-002 introduces. Without an orchestrator, every PRD-002 backend pays its setup cost on every spawn.

ACP is per-spawn by design — clients launch the agent via `agent_servers.<name>.command`, hand it stdio, and treat its lifetime as scoped to the connection. The spec does not contemplate a long-running orchestrator. Fighting that takes work, but the work is bounded: keep the spawn surface intact (the binary still accepts stdio and speaks ACP), make the binary a forwarder to a long-running daemon that owns the actual ACP server. Each spawn = thin client. The daemon = orchestrator for all of them.

### What "daemon" buys (concrete)

- **Cross-window session visibility.** Daemon-level `SessionRegistry` keys live `AgentSession`s by sessionId; every connected client sees the union via `session/list`.
- **Shared SSH ControlMaster connections.** First spawn opens the master; subsequent spawns reuse the multiplexed channel. Per-op latency drops from ~150ms to ~5ms.
- **Shared HTTP TTL cache.** First spawn fetches; cache hits for the lifetime of the daemon, across all clients.
- **Shared parsed manifest.** Per-cwd manifest is parsed once; cached by stat-mtime.
- **Single pi runtime.** Model registry, extension runner, auth storage instantiated once. New `AgentSession`s built from that shared base.
- **Constant fast startup.** New client connections complete handshake in <50ms once daemon is warm.

### What "daemon" does NOT change

- ACP wire surface — still JSON-RPC NDJSON over stdio, from the client's perspective.
- Per-session semantics — each `AgentSession` still has its own message stream, abort handle, tool state.
- Pi runtime model — `createAgentSession({...})` still constructs one session at a time.
- `--terminal-login` flow — still spawns pi directly in the foreground (does NOT go through daemon).
- Per-client capabilities — each ACP connection negotiates its own `clientCapabilities`.

---

## 2. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| **Long-running daemon** | Single process holds all live `AgentSession`s for one user | One daemon process per UID after first spawn |
| **Thin-client binary** | `pi-acp` (without `--daemon`) is socket forwarder | `dist/index.mjs` < 20kB minified for the client path |
| **Auto-spawn** | First client invocation that finds no daemon spawns one | Verified by integration test |
| **Auto-shutdown** | Daemon exits cleanly after configurable idle period | Default 600s after last client disconnect; tunable via env var |
| **Cross-window session visibility** | `session/list` returns sessions from all currently-connected clients of the same daemon | Verified by integration test |
| **Shared SSH ControlMaster** | Second spawn reuses ssh-master from first spawn | SSH op latency < 20ms on second invocation (vs ~150ms cold) |
| **Backward compat** | Existing `agent_servers` configs in Zed work unchanged | No client config changes required |
| **Terminal-login unchanged** | `pi-acp --terminal-login` still spawns pi directly | Doesn't engage daemon at all |
| **Crash isolation** | One client misbehaving does not affect other clients | Per-connection error containment; daemon survives client crashes |

**Guardrails (must not regress):**

- Per-spawn behavior remains usable as a fallback (`PI_ACP_NO_DAEMON=1` env var disables daemon).
- ACP protocol semantics unchanged.
- v0.5 reactive auth path stays identical.
- Existing 186 tests pass unmodified.
- `bin: pi-acp` shape preserved; bin still callable with stdio by Zed.
- Semantic-release pipeline unchanged.

---

## 3. Users & Use Cases

### Primary: Multi-window Zed user

> As a developer with three Zed windows open on the same project, I want to start a long pi session in window 1, then resume it in window 2 (e.g., my laptop screen vs external monitor split), seeing it in `session/list` without manually copying a session ID.

### Primary: Quick-action user

> As a developer who opens pi-acp from a Raycast/Alfred quick action many times per day, I want subsequent invocations to feel instant — not the 200ms cold-start of a fresh Node + pi load.

### Primary: PRD-002 SSH-resource user

> As a user with an `ssh` resource source pointing at my dev VM, I want the first session to open the SSH ControlMaster connection and every subsequent session in any window to reuse that master, not re-handshake.

### Secondary: Single-window user (status quo)

> As a developer who only ever has one Zed window open, I want pi-acp to work exactly as it did in v0.5 — no daemon-related surprises, no extra processes I have to manage. The daemon spawns silently, idles out silently, no visible behavior change.

### Secondary: Operator debugging

> As an operator, I want to inspect daemon state (`pi-acp --daemon-status`), see what clients are connected, and force-kill the daemon if it misbehaves (`pi-acp --daemon-stop`).

---

## 4. Scope

### In scope (v0.6 — PRD-003 part)

1. **Daemon mode.** New `pi-acp --daemon` flag runs the long-running process. Hosts shared singletons: `SessionRegistry`, `ResourceLoaderPool`, `SshPool`, `HttpCache`, `ManifestCache`. Listens on a per-user Unix domain socket (Mac/Linux) or named pipe (Windows).
2. **Thin-client mode.** Default `pi-acp` (no flag) is the forwarder. Connects to the daemon's socket; if absent, auto-spawns daemon then connects. Pipes `process.stdin → socket` and `socket → process.stdout`. Exit when socket closes.
3. **Per-connection ACP server inside daemon.** Each incoming socket connection gets its own `AgentSideConnection` wrapping the socket; one `PiAcpAgent` instance per connection, sharing daemon-level singletons via dependency injection.
4. **`SessionRegistry`** — daemon-level singleton map `sessionId → { piSession, ownerConnectionId, refCount }`. Sessions outlive the connection that created them when `refCount > 0` (e.g., another client also opened them).
5. **Auto-spawn.** Client tries to `connect()` to socket. On `ENOENT` / `ECONNREFUSED` / stale-socket, client forks `pi-acp --daemon` detached, waits up to 3s polling, then connects. Lockfile (`<socket>.lock`) prevents duplicate spawns.
6. **Idle shutdown.** Daemon tracks active connections. When count drops to 0, starts a timer (default 600s, configurable via `PI_ACP_DAEMON_IDLE_SECONDS`). Timer cancelled on next connection. Timer fire → graceful shutdown.
7. **Escape hatches.** `PI_ACP_NO_DAEMON=1` forces per-spawn mode (the v0.5 path). `--daemon-status` prints connections / sessions / uptime. `--daemon-stop` sends shutdown to a running daemon.
8. **`--terminal-login` bypass.** Continues to spawn pi directly in the foreground; never touches the daemon.

### Out of scope / deferred

| What | Why | Tracked in |
|------|-----|------------|
| Daemon across multiple machines | True distributed orchestration is a different category of problem. | Future PRD |
| Network-exposed daemon (TCP) | Unix-socket / named-pipe is fine for one user on one machine. Network exposure has auth/TLS demands. | Future PRD |
| Cross-user daemon | One daemon per UID. Multi-user requires permission model not designed here. | Future PRD |
| Daemon-side ACP transport translation | Daemon talks ACP NDJSON-over-stream the same way the v0.5 process did. No re-framing. | N/A |
| Hot-reload daemon binary | Daemon must restart for code updates. v0.5 install model. | N/A |
| Per-connection rate limits / quotas | One user, one machine — quota policy is overkill. | Future PRD |
| MCP server wiring per session | Still blocked on pi SDK exposing per-session MCP config. | PRD-001 follow-up |

### Design for future (build with awareness)

- **Network transport.** The socket layer should be a thin abstraction over `stream.Duplex` so swapping unix-socket for TCP+TLS is a transport-layer change, not a daemon-internals change.
- **Cross-user daemon.** Per-UID socket path now (`pi-acp-${UID}.sock`); if cross-user ever lands, the path naming pattern leaves room.

---

## 5. Functional Requirements

### FR-1: Daemon process

`pi-acp --daemon` launches the long-running orchestrator.

Responsibilities:

- Bind Unix socket (`${XDG_RUNTIME_DIR:-/tmp}/pi-acp-${UID}.sock`) or named pipe (`\\.\pipe\pi-acp-${USERNAME}`).
- Acquire `<socket>.lock` exclusive lock (PID-tracked). Refuse to start if another daemon already owns it.
- Construct daemon-level singletons:
  - `SessionRegistry`
  - `ResourceLoaderPool` (per-manifest-hash keyed)
  - `SshPool` (per-host keyed, ControlMaster lifecycle)
  - `HttpCache` (URL+TTL keyed)
  - `ManifestCache` (per-cwd keyed by stat-mtime)
- Listen for connections. Per connection, create `AgentSideConnection` + `PiAcpAgent` with shared-state DI.
- Track connection count. On count → 0, start idle timer. On count > 0, cancel timer.
- On idle timer fire OR SIGTERM/SIGINT: gracefully shut down — close all `PiAcpAgent`s, dispose all `AgentSession`s, release singletons, remove socket file + lockfile, exit 0.

**Acceptance criteria:**

```gherkin
Given pi-acp --daemon is invoked and no daemon currently running
When the daemon binds the socket
Then a UNIX socket file appears at the configured path
And a <socket>.lock file with the daemon PID appears
And the daemon process holds the file lock

Given a daemon is already running
When pi-acp --daemon is invoked again
Then the second invocation prints an error containing "already running" with the running PID
And exits with code 1

Given a daemon with no connected clients
When the idle timeout elapses
Then the daemon disposes all singletons, removes the socket file and lockfile, and exits 0
```

### FR-2: Thin-client binary

Default invocation (`pi-acp` with no flag) is the forwarder.

Logic:

```ts
const socketPath = computeSocketPath();
let socket = tryConnect(socketPath);
if (!socket) {
  await spawnDaemon();              // pi-acp --daemon, detached
  socket = await waitForSocket(socketPath, { timeoutMs: 3000 });
}
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
process.on("SIGINT", () => socket.destroy());
process.on("SIGTERM", () => socket.destroy());
```

Console redirect block from PRD-001 FR-5 stays — even in client mode, stray bytes on stdout corrupt the ACP frame stream coming back from the daemon.

`--terminal-login` flag takes precedence over client mode — invokes pi directly in the foreground, never touches the socket.

`PI_ACP_NO_DAEMON=1` skips daemon entirely; client mode falls back to in-process v0.5 behavior (instantiates `PiAcpAgent` locally, no socket).

**Acceptance criteria:**

```gherkin
Given no daemon currently running
When pi-acp is invoked with ACP JSON-RPC on stdin
Then the client spawns a daemon, waits for the socket, then forwards stdin to the daemon
And the daemon's response frames appear on the client's stdout

Given a daemon is already running
When pi-acp is invoked
Then the client connects to the existing socket within 50ms
And no additional daemon process spawns

Given PI_ACP_NO_DAEMON=1 in env
When pi-acp is invoked
Then the client runs PiAcpAgent in-process (v0.5 behavior) and never touches the socket
```

### FR-3: Per-connection ACP server in daemon

Each socket connection accepted by the daemon spawns:

```ts
const stream = ndJsonStream(socketIn, socketOut);
const conn = new AgentSideConnection(
  (acp) => new PiAcpAgent(acp, {
    sessionRegistry,
    resourceLoaderPool,
    sshPool,
    httpCache,
    manifestCache,
  }),
  stream,
);
```

`PiAcpAgent` constructor signature extended to accept a `daemonContext` arg holding the shared singletons. Sessions created by this agent register into `sessionRegistry` keyed by `sessionId` with `ownerConnectionId`. `closeSession` decrements `refCount`; only when `refCount === 0` does the underlying `AgentSession` dispose.

Per-client state kept on the `PiAcpAgent` instance:
- `clientCapabilities` (from `initialize`)
- Owned `sessionId` set
- Current ACP `connection` reference (for `fs/read_text_file` callbacks etc.)

Shared state lives in `daemonContext`.

**Acceptance criteria:**

```gherkin
Given two clients connected to the same daemon
When client A creates session X via session/new
Then session X is registered in the SessionRegistry
And client B's session/list response includes session X

Given client A owns session X and calls closeSession
When no other client references session X
Then refCount drops to 0 and the underlying AgentSession is disposed

Given client A owns session X and calls closeSession
When client B has also resumed session X
Then refCount stays > 0 and the AgentSession is NOT disposed
```

### FR-4: Socket path + lockfile

Per-user socket path:

- **Unix** (Linux, macOS): `${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pi-acp-${UID}.sock`
- **Windows**: `\\.\pipe\pi-acp-${USERNAME}`

Lockfile: `${socketPath}.lock` containing the daemon PID. Acquired with `proper-lockfile` semantics (or equivalent). Stale-lock detection: if PID in lockfile is not alive, remove and retry.

Stale-socket handling: if socket file exists but `connect()` returns `ECONNREFUSED`, client removes the stale file and proceeds to auto-spawn.

**Acceptance criteria:**

```gherkin
Given /tmp/pi-acp-501.sock exists but no daemon process is alive
When a client invokes pi-acp
Then the client detects the stale socket, removes it, spawns a daemon, and connects
```

### FR-5: Cross-window session visibility

`session/list` returns the union of sessions across all connected clients of the daemon, NOT just sessions owned by the requesting client.

Each returned `SessionInfo` carries `_meta.piAcp.ownedByThisConnection: boolean` so the client can render a UX hint ("opened in another window") if it wants.

Persisted-but-not-loaded sessions (in `~/.pi/agent/sessions/`) continue to be enumerable as today — daemon delegates to `SessionManager.listAll()` and merges with the in-memory registry, deduping by `sessionId`.

**Acceptance criteria:**

```gherkin
Given client A has session X live in the daemon
And client B is connected to the same daemon
When client B calls session/list
Then the response includes session X
And session X's _meta.piAcp.ownedByThisConnection is false

Given session Y exists on disk but is not currently live in the daemon
When any client calls session/list
Then the response includes session Y
And session Y's _meta.piAcp.ownedByThisConnection is false
```

### FR-6: Idle shutdown

Daemon tracks `activeConnectionCount`. State machine:

- `count > 0`: armed but not running
- `count === 0`: start `idleTimer` with `PI_ACP_DAEMON_IDLE_SECONDS` (default 600).
- New connection: cancel `idleTimer`.
- `idleTimer` fires: graceful shutdown.

Graceful shutdown:
1. Refuse new connections (close the listener).
2. Dispose all `AgentSession`s in `SessionRegistry`. Each `.dispose()` flushes any in-flight state.
3. Close all socket connections (in practice should be 0 at this point).
4. Close shared singletons (SSH pool sends `-O exit` to ControlMasters; HTTP cache drops; manifest cache drops).
5. Remove socket file + lockfile.
6. Exit 0.

**Acceptance criteria:**

```gherkin
Given a daemon with 0 active connections and idle timer running
When the idle timer fires (or PI_ACP_DAEMON_IDLE_SECONDS=2 has elapsed in test)
Then the daemon closes the listener, disposes singletons, removes socket + lockfile, and exits 0
```

### FR-7: Operator commands

`pi-acp --daemon-status`:
- If no daemon running: prints `pi-acp daemon: not running` to stderr, exit 1.
- If running: connects, requests status frame, prints JSON to stdout (uptime, connection count, session count, singleton memory rough estimates).

`pi-acp --daemon-stop`:
- If no daemon running: prints `pi-acp daemon: not running` to stderr, exit 0.
- If running: connects, sends shutdown frame, waits for daemon exit (up to 5s), prints `pi-acp daemon: stopped` to stderr, exit 0.

Both commands speak a small control-frame protocol on the same socket — frame is JSON-RPC with method `daemon/status` or `daemon/shutdown`, namespaced so it does NOT collide with the ACP method space. Daemon recognizes these methods at the socket-protocol level, before handing off to `AgentSideConnection`.

**Acceptance criteria:**

```gherkin
Given a daemon is running with 2 connected clients and 5 live sessions
When pi-acp --daemon-status is invoked
Then the output JSON contains uptime_seconds, connections: 2, sessions: 5

Given a daemon is running
When pi-acp --daemon-stop is invoked
Then the daemon disposes all state and exits 0 within 5 seconds
And the socket file is removed
```

### FR-8: Backward compat escape hatch

`PI_ACP_NO_DAEMON=1` env var (or `--no-daemon` CLI flag) forces the v0.5 per-spawn path. No socket activity. No daemon spawn. The thin-client code path skips the socket and instead constructs `PiAcpAgent` in-process exactly like v0.5.

This is the recovery path if the daemon ever misbehaves; it should remain functional indefinitely as a fallback. CI should run the full test suite in both daemon and no-daemon modes.

**Acceptance criteria:**

```gherkin
Given PI_ACP_NO_DAEMON=1 in env
When the full v0.5 test suite runs against the v0.6 binary
Then 100% of tests pass identical to v0.5

Given a daemon is running
And a client invokes pi-acp with PI_ACP_NO_DAEMON=1
Then the client ignores the daemon and runs in-process
```

---

## 6. Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| **Latency: cold start** | First client invocation (daemon spawn + handshake) completes in <500ms on a warm filesystem. |
| **Latency: warm start** | Subsequent client invocations complete socket connect + ACP `initialize` in <50ms. |
| **Memory** | Daemon idle memory < 80MB (one pi runtime, no active sessions). Per-session overhead matches v0.5. |
| **Crash isolation** | A panic in one connection's `PiAcpAgent` must NOT crash the daemon. Daemon catches `uncaughtException` per connection, closes that socket, continues serving others. |
| **Stdout discipline** | Daemon writes nothing to its own stdout/stderr unless `PI_ACP_DAEMON_DEBUG=1`. Client stdout carries only ACP frames forwarded from daemon. |
| **Signal handling** | Daemon: `SIGINT`/`SIGTERM` → graceful shutdown. Client: `SIGINT`/`SIGTERM` → close socket → exit. |
| **Lockfile cleanup** | Daemon removes its lockfile on clean shutdown. Stale-lock detection (PID not alive) handles crash recovery. |
| **Concurrency** | Multiple clients concurrently calling `session/new` on the same daemon must not collide. `SessionRegistry` mutations protected. |
| **Backwards compat** | `PI_ACP_NO_DAEMON=1` falls back to v0.5 in-process path. CI runs both modes. |

---

## 7. Risks & Assumptions

### Risks

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Pi `0.69` session-replacement context invalidation breaks concurrent `AgentSession` ownership | High | Med | Phase-1 integration test runs two `AgentSession`s concurrently before declaring done. If sharing breaks, daemon spins one `AgentSession` per session-id with strict isolation; shared singletons drop to a smaller set. |
| Auto-spawn race when two clients start within ~10ms | Med | Low | Lockfile + `O_EXCL` open. Loser polls for socket file. Bounded retry. |
| Stale lockfile after daemon crash | Med | Med | PID-check: if PID in lockfile not alive (`kill -0`), reclaim. |
| Idle shutdown fires while a client is connecting | Low | Low | Timer cancellation runs on `listener.connection` event before the new socket is fully wired; race window is sub-ms but exists. Mitigation: if shutdown started, refuse new connection cleanly so client retries (auto-spawn). |
| Daemon misbehaves and accepts connections but never responds | Med | Low | Client has connect-timeout (3s). On timeout, client kills daemon (lockfile-PID → SIGKILL), removes socket, re-spawns. |
| Windows named-pipe semantics differ from Unix sockets | Med | Med | Wrap the transport in a `stream.Duplex` adapter. Use `net.connect({ path })` which handles both. Targeted Windows CI added. |
| `--terminal-login` breaks because users expect daemon-mode | Low | Low | `--terminal-login` flag is explicit; documented to never engage daemon. |
| Shared `ResourceLoaderPool` returns stale entries when `.pi-acp.yaml` changes on disk | Med | Med | Manifest cache keyed by `stat(path).mtime`; pool entry invalidated on stat change. |
| Socket path collisions with other tools | Low | Low | Namespace under per-UID path. `pi-acp-${UID}.sock` is unique enough; Windows pipe name also user-scoped. |

### Assumptions

- One user, one workstation, one daemon. Cross-user is a future problem.
- Node's `net.createServer` / `net.connect` work on macOS, Linux, Windows.
- Pi `0.75.3`'s shared state (model registry, auth storage) is safe for concurrent reads. Concurrent `createAgentSession` calls do not race on shared state. To be verified during implementation.
- ACP clients reasonably support being given a thin-client binary path — `agent_servers.<name>.command: pi-acp` requires no changes.

---

## 8. Design Decisions

### D1: Single daemon per UID, not per cwd / per project

**Options:**
1. One daemon per project.
2. One daemon per user (UID-scoped socket).

**Decision:** One per UID. ADR-0010.

**Rationale:** Project boundary is fluid; users often work across projects in the same window-set. UID is the natural identity boundary on a workstation. Cross-project `session/list` is a feature, not a leak.

### D2: Unix-socket transport, not TCP

**Options:**
1. TCP localhost.
2. Unix domain socket (with named-pipe fallback on Windows).

**Decision:** Unix socket / named pipe. ADR-0010.

**Rationale:** No port allocation, no firewall surface, filesystem-permission-bounded by default. TCP would require auth tokens we don't need.

### D3: Auto-spawn from thin client

**Options:**
1. User runs `pi-acp --daemon` manually (or via launchd / systemd unit).
2. First client invocation transparently spawns the daemon.

**Decision:** Auto-spawn. ADR-0010.

**Rationale:** Zero-config UX. The user already configured `agent_servers.<name>.command: pi-acp` — that's the only thing they want to write.

### D4: Idle shutdown timer

**Options:**
1. Daemon runs forever once started.
2. Idle timer (default 600s) shuts daemon down when no clients connected.

**Decision:** Idle timer. ADR-0010.

**Rationale:** Don't leave a process on the user's system forever just because they once opened Zed. 10-minute default is long enough that quick-action use cases don't pay restart cost; short enough that the daemon doesn't outlive the user's work.

### D5: Cross-window session visibility is on by default

**Options:**
1. Each connection only sees its own sessions in `session/list`.
2. `session/list` returns the union; `_meta.piAcp.ownedByThisConnection` lets clients filter.

**Decision:** Union with metadata. ADR-0010.

**Rationale:** The motivating user story. Filtering is a client-side concern.

### D6: `PI_ACP_NO_DAEMON=1` escape hatch

**Options:**
1. No escape hatch; daemon always used.
2. Env var (and `--no-daemon` CLI flag) restores v0.5 in-process behavior.

**Decision:** Escape hatch exists. ADR-0010.

**Rationale:** Insurance. If the daemon ever has a bug that affects a user during work, they have a one-flag fallback. Also enables running the full v0.5 test suite in CI as a regression gate.

### D7: Operator commands speak in-band on the socket

**Options:**
1. Separate control socket for `--daemon-status` / `--daemon-stop`.
2. In-band on the main socket; control methods (`daemon/status`, `daemon/shutdown`) recognized before ACP handoff.

**Decision:** In-band. ADR-0010.

**Rationale:** Single socket file, single permission scope, one bind/connect path. Method-name namespace separation is sufficient.

---

## 9. File Breakdown

| File | Change | FR |
|------|--------|-----|
| `src/daemon/index.ts` | New | FR-1, FR-3, FR-6 — daemon entry; `pi-acp --daemon` lands here |
| `src/daemon/socket.ts` | New | FR-4 — per-OS socket path resolver + lockfile management |
| `src/daemon/context.ts` | New | FR-3 — `DaemonContext` interface + singleton container |
| `src/daemon/session-registry.ts` | New | FR-3, FR-5 — daemon-level `SessionRegistry` |
| `src/daemon/control.ts` | New | FR-7 — `daemon/status` / `daemon/shutdown` method handlers |
| `src/daemon/idle.ts` | New | FR-6 — idle timer logic |
| `src/client/index.ts` | New | FR-2, FR-8 — thin-client entry; forwarder |
| `src/client/auto-spawn.ts` | New | FR-2 — auto-spawn helper |
| `src/index.ts` | Modify | Top-level mode router: client (default) vs daemon (`--daemon`) vs terminal-login (`--terminal-login`) vs operator commands (`--daemon-status`, `--daemon-stop`) vs no-daemon (env var) |
| `src/acp/agent.ts` | Modify | `PiAcpAgent` constructor accepts optional `DaemonContext`; resource composition pulls from `daemonContext.resourceLoaderPool` |
| `src/acp/session.ts` | Modify | `SessionRegistry` registration/deregistration on `newSession`/`closeSession` |
| `test/component/daemon-lifecycle.test.ts` | New | FR-1, FR-6 — spawn, idle, shutdown |
| `test/component/daemon-multi-client.test.ts` | New | FR-3, FR-5 — cross-window session visibility |
| `test/component/auto-spawn.test.ts` | New | FR-2 — client auto-spawns daemon on cold start |
| `test/component/no-daemon-mode.test.ts` | New | FR-8 — `PI_ACP_NO_DAEMON=1` runs in-process |
| `test/component/daemon-control.test.ts` | New | FR-7 — `--daemon-status`, `--daemon-stop` |
| `test/unit/socket-path.test.ts` | New | FR-4 — OS-specific path resolution |
| `docs/adr/ADR-0010-daemon-client-split.md` | New | — |
| `docs/architecture/plan-runtime-daemon.md` | New | — |
| `docs/prd/PRD-002-portable-runtime.md` | Modify | Cross-reference PRD-003; note shared-state hooks |
| `README.md` | Modify | Document daemon mode + escape hatch + operator commands |

---

## 10. Dependencies & Constraints

- Node `net` (built-in) — socket server + client.
- Node `child_process.fork` for auto-spawn (detached: `detached: true, stdio: "ignore"`).
- Existing deps; no new runtime deps required for daemon work itself.
- `proper-lockfile` (or hand-rolled equivalent) for lockfile semantics. Cheap dep, but if avoidable, hand-roll using `O_EXCL`.
- Engines stay `>=24`.
- Pi `0.75.3` (verify concurrent session-creation safety).
- ACP SDK `^0.22.1`.

---

## 11. Rollout Plan

Phased — daemon work lands BEFORE PRD-002 backend phases so they can leverage shared singletons.

1. **Phase 0** — This PRD + ADR-0010 + plan. No code.
2. **Phase 1** — Daemon skeleton (FR-1, FR-2, FR-4, FR-8). Socket transport, auto-spawn, in-process fallback. No shared singletons yet — daemon hosts vanilla `PiAcpAgent` per connection with no cross-state. Goal: ACP wire surface unchanged from outside.
3. **Phase 2** — `SessionRegistry` + cross-window visibility (FR-3, FR-5). Sessions register; `session/list` returns the union; `closeSession` refcounts.
4. **Phase 3** — Idle shutdown + operator commands (FR-6, FR-7).
5. **Phases 4-11** — PRD-002 backends (`VirtualResourceLoader`, manifest, SSH, HTTP, ACP-FS, `import_resource`, cwd modes, diagnostics). Each plugs into `DaemonContext` shared singletons.
6. **Phase 12** — CHANGELOG, tag `v0.6.0`.

Phase 1 alone is shippable as an internal-only mini-release if needed.

---

## 12. Open Questions

| # | Question | Owner | Due | Status |
|---|----------|-------|-----|--------|
| Q1 | Does pi `0.75.3` permit concurrent `createAgentSession` calls without racing on shared model registry / auth storage? | Victor | Phase 1 | Open |
| Q2 | `idle timeout = 600s` reasonable, or should it be shorter for power-user multi-window scenarios? | Victor | Phase 3 | Open — start 600s; iterate based on telemetry. |
| Q3 | Should the daemon track per-session ownership at the connection level, or at a higher level (e.g., user-tagged)? | Victor | Phase 2 | Open — connection-level for v0.6; user-tag in v0.7+. |
| Q4 | Windows named-pipe lockfile semantics differ from Unix; need a different approach? | Victor | Phase 1 | Open — start with PID-in-pipe-name; refine if needed. |
| Q5 | Crash-isolation: when a connection's `PiAcpAgent` throws, should the daemon dispose just that connection or also the connection's sessions? | Victor | Phase 1 | Open — lean dispose connection only; sessions remain in registry for resume. |
| Q6 | Should `pi-acp --daemon-status` output be human-readable text or JSON? | Victor | Phase 3 | Open — JSON for programmability, human-readable mode via `--text`. |
| Q7 | `PI_ACP_DAEMON_DEBUG=1` write debug log to where? stderr (visible in launchd / systemd logs) or a file in `${XDG_STATE_HOME}/pi-acp/`? | Victor | Phase 1 | Open — start stderr. |

---

## 13. Related

| Issue | Relationship |
|-------|-------------|
| PRD-001 v0.5 release | predecessor — daemon swallows the v0.5 in-process model as the `--no-daemon` fallback. |
| PRD-002 portable runtime | sibling — daemon hosts the shared singletons PRD-002 introduces. |
| `@earendil-works/pi-coding-agent@v0.75.3` | depends-on — concurrent session safety (Q1). |
| `@agentclientprotocol/sdk@v0.22.1` | depends-on — per-connection `AgentSideConnection`. |

---

## 14. Changelog

| Date | Change | Author |
|------|--------|--------|
| 2026-05-19 | Initial draft (v1.0) — daemon + thin-client architecture in response to multi-window / shared-state user need. | Victor |

---

## 15. Verification (Appendix)

Post-implementation checklist:

1. `pi-acp --daemon` spawns successfully; socket file appears at expected path; lockfile contains daemon PID.
2. `pi-acp` (thin client) auto-spawns daemon on first invocation; subsequent invocations reuse it (verified by stable daemon PID).
3. Two concurrent clients see each other's sessions in `session/list`.
4. `closeSession` from one client does NOT dispose a session another client also holds.
5. Daemon idle-shuts-down after `PI_ACP_DAEMON_IDLE_SECONDS` with no connected clients; socket + lockfile removed.
6. `PI_ACP_NO_DAEMON=1` runs full v0.5 test suite unchanged.
7. `pi-acp --daemon-status` returns JSON when daemon is up; exits 1 with stderr message otherwise.
8. `pi-acp --daemon-stop` triggers graceful shutdown within 5s.
9. SIGKILL on daemon leaves stale lockfile; next client invocation detects PID-not-alive and reclaims.
10. Crashing one connection's agent does NOT crash daemon or other connections.
