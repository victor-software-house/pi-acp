---
title: "pi-acp v0.6: Daemon + Thin-Client Implementation Plan"
prd: "PRD-003-runtime-daemon"
date: 2026-05-19
author: "Victor Araujo"
status: Draft
---

# Plan: pi-acp v0.6 — Daemon + Thin-Client Implementation

## Source

- **PRD**: `docs/prd/PRD-003-runtime-daemon.md`
- **Plan sibling**: `docs/architecture/plan-portable-runtime.md` (PRD-002 — backends now plug into daemon's shared singletons).

## Architecture Overview

`pi-acp` v0.5 ran one Node process per ACP client spawn. v0.6 splits that into two roles inside the same bin:

- **Thin client** (default invocation, no flag): connects to per-UID Unix socket / named pipe, forwards stdio in both directions. Auto-spawns daemon if absent.
- **Daemon** (`--daemon` flag): one process per UID. Holds shared singletons (`SessionRegistry`, `ResourceLoaderPool`, `SshPool`, `HttpCache`, `ManifestCache`). One `AgentSideConnection` + `PiAcpAgent` per accepted socket connection.

The v0.5 binary's `PiAcpAgent` + ACP wiring moves wholesale into the daemon. The new client code is ~50 lines of stdio forwarding + auto-spawn.

`PI_ACP_NO_DAEMON=1` keeps the v0.5 in-process path alive as an escape hatch.

## Guardrails (must not regress)

- v0.5 reactive auth path (PRD-001 FR-4) — unchanged behavior.
- `--terminal-login` (PRD-001) — never engages daemon.
- 186 existing tests pass both in daemon mode and `PI_ACP_NO_DAEMON=1` mode.
- ACP wire surface unchanged (NDJSON over stdio from the client's perspective).
- `bin: pi-acp` shape preserved.
- Console redirect to stderr (PRD-001 FR-5) applies in both client and daemon modes.

## Components

### Mode router (`src/index.ts` modify)

**Purpose**: Dispatch bin invocation to the correct code path.

**Behavior**:

```ts
if (argv.includes("--terminal-login"))      → terminal-login flow (v0.5 unchanged)
else if (argv.includes("--daemon"))         → daemon main
else if (argv.includes("--daemon-status"))  → operator: status
else if (argv.includes("--daemon-stop"))    → operator: shutdown
else if (env.PI_ACP_NO_DAEMON === "1" ||
         argv.includes("--no-daemon"))      → in-process v0.5 path (fallback)
else                                        → thin-client (default)
```

### Daemon entry (`src/daemon/index.ts` new)

**Purpose**: Daemon main — bind socket, acquire lockfile, listen for clients.

**Key details**:

- Resolves socket path via `socketPath()` from `src/daemon/socket.ts`.
- Acquires `<socket>.lock` exclusive lock with PID; refuses to start if alive daemon already holds it.
- Constructs `DaemonContext` with shared singletons (`SessionRegistry`, `ResourceLoaderPool`, etc. — pools are empty placeholders in Phase 1; populated by later phases).
- `net.createServer((socket) => acceptClient(socket, ctx))`.
- Handles `SIGINT` / `SIGTERM` → graceful shutdown.
- Owns the idle timer (Phase 3 wires it).

### Socket path + lockfile (`src/daemon/socket.ts` new)

**Purpose**: Per-OS path resolution + lockfile semantics.

**Key details**:

- `socketPath()`:
  - Unix: `${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pi-acp-${UID}.sock` (`UID` from `process.getuid()`).
  - Windows: `\\.\pipe\pi-acp-${USERNAME}`.
- `lockfilePath() = socketPath() + ".lock"`.
- `acquireLock()`:
  - Read PID from lockfile if exists.
  - `kill -0 PID` → if alive, return `{ heldBy: PID }`; if dead, remove stale lockfile + socket.
  - Open lockfile with `O_CREAT | O_EXCL | O_WRONLY`. Write own PID. On `EEXIST`, retry stale check once.
- `releaseLock()` removes lockfile.
- `removeStaleSocketIfAny()` — used by client on `ECONNREFUSED` if PID-check says no daemon alive.

### DaemonContext + shared singletons (`src/daemon/context.ts` new)

**Purpose**: Inject shared state into per-connection `PiAcpAgent`s.

**Phase 1 shape** (singletons mostly empty stubs to populate in PRD-002 phases):

```ts
export interface DaemonContext {
  sessionRegistry: SessionRegistry;   // Phase 2
  resourceLoaderPool: ResourceLoaderPool;   // PRD-002 Phase 2-equivalent
  sshPool: SshPool;                   // PRD-002 SSH backend
  httpCache: HttpCache;               // PRD-002 HTTP backend
  manifestCache: ManifestCache;       // PRD-002 manifest
  idleTracker: IdleTracker;           // Phase 3
}
```

Phase 1 lands the interface + Phase-1-relevant fields; other fields are stub implementations.

### SessionRegistry (`src/daemon/session-registry.ts` new — Phase 2)

**Purpose**: Daemon-level map of all live sessions.

**Phase 2 shape**:

```ts
interface SessionEntry {
  sessionId: string;
  piSession: AgentSession;
  acpSession: PiAcpSession;
  ownerConnectionId: string;
  alsoHeldBy: Set<string>;          // connectionIds that have resumed this session
  cwd: string;
}

class SessionRegistry {
  register(entry): void;
  release(sessionId, connectionId): boolean;  // true if disposed
  listAll(): SessionInfo[];
  get(sessionId): SessionEntry | undefined;
}
```

`closeSession` invokes `release(sessionId, connectionId)`. The entry's `alsoHeldBy` set tracks resumed-via-other-connections; only when both `owner` releases and `alsoHeldBy` is empty does the underlying `piSession.dispose()` run.

### Idle tracker (`src/daemon/idle.ts` new — Phase 3)

**Purpose**: Track active connection count, fire idle shutdown.

**Shape**:

```ts
class IdleTracker {
  private active = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private idleMs: number, private onIdle: () => void) {}
  bump(delta: 1 | -1): void;  // 1 on connect, -1 on disconnect
  // bump(+1): cancel timer
  // bump(-1) leading to active=0: start timer with onIdle
}
```

### Control methods (`src/daemon/control.ts` new — Phase 3)

**Purpose**: Recognize `daemon/status` and `daemon/shutdown` frames before ACP handoff.

Each accepted socket: peek at the first frame. If `method === "daemon/status"` or `"daemon/shutdown"`, handle it inline and close. Otherwise, hand the socket to the ACP path (`new AgentSideConnection(...)` over `ndJsonStream`).

`daemon/status` response:
```json
{
  "jsonrpc": "2.0",
  "id": <id>,
  "result": {
    "uptimeSeconds": <number>,
    "connections": <number>,
    "sessions": <number>,
    "pid": <number>,
    "version": "<pi-acp version>"
  }
}
```

`daemon/shutdown` response: empty result, then initiate graceful shutdown.

### Thin-client entry (`src/client/index.ts` new)

**Purpose**: Connect to socket, forward stdio.

**Shape**:

```ts
const path = socketPath();
let socket = await tryConnect(path);
if (!socket) {
  await autoSpawnDaemon();         // src/client/auto-spawn.ts
  socket = await waitForSocket(path, 3000);
  if (!socket) throw new Error("pi-acp daemon failed to start");
}
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
socket.on("error", (err) => { process.stderr.write(`pi-acp: ${err.message}\n`); process.exit(1); });
process.on("SIGINT", () => socket.destroy());
process.on("SIGTERM", () => socket.destroy());
```

### Auto-spawn (`src/client/auto-spawn.ts` new)

**Purpose**: Fork `pi-acp --daemon` detached.

**Shape**:

```ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export async function autoSpawnDaemon(): Promise<void> {
  const child = spawn(process.execPath, [process.argv[1], "--daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}
export async function waitForSocket(path: string, timeoutMs: number): Promise<Socket | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sock = await tryConnect(path);
    if (sock) return sock;
    await sleep(50);
  }
  return null;
}
```

### `PiAcpAgent` (`src/acp/agent.ts` modify)

**Purpose**: Receive `DaemonContext` via constructor; use it for shared singletons.

**Phase 1 shape**: Constructor adds optional `daemonContext` parameter. When provided, sessions register/deregister via `daemonContext.sessionRegistry`. When absent (in-process / `PI_ACP_NO_DAEMON=1`), behavior identical to v0.5.

Future phases (PRD-002) wire `resourceLoaderPool`, `sshPool`, etc.

## Implementation Order

| Phase | Component | Status | Dependencies | Scope |
|-------|-----------|--------|--------------|-------|
| 0 — Docs | PRD-003 + ADR-0010 + this plan + PRD-002 cross-reference update | In flight | None | M |
| 1 — Daemon skeleton | Mode router, socket transport, auto-spawn, in-process fallback. Daemon hosts vanilla `PiAcpAgent` per connection with empty `DaemonContext`. | Pending | Phase 0 | L |
| 2 — SessionRegistry + cross-window | `SessionRegistry` + session ownership refcounting + `session/list` union | Pending | Phase 1 | M |
| 3 — Idle shutdown + operator | `IdleTracker` + `daemon/status` + `daemon/shutdown` | Pending | Phase 1 | M |
| 4+ — PRD-002 backends | `VirtualResourceLoader`, manifest, SSH, HTTP, ACP-FS, `import_resource`, cwd modes, diagnostics — each plugs into `DaemonContext` | Pending | Phase 3 | Per plan-portable-runtime |
| Final — Release | CHANGELOG, tag v0.6.0 | Pending | All | XS |

Phase 1 is the foundation. Phases 2 and 3 are independent and can land in either order or in parallel. PRD-002 phases follow.

## Phase Detail

### Phase 0 — Docs (this commit set)

1. `docs/prd/PRD-003-runtime-daemon.md` ✔ written.
2. `docs/adr/ADR-0010-daemon-client-split.md` ✔ written.
3. `docs/architecture/plan-runtime-daemon.md` (this file).
4. PRD-002 + plan-portable-runtime cross-reference update.

### Phase 1 — Daemon skeleton

1. `src/daemon/socket.ts` — `socketPath()`, `lockfilePath()`, `acquireLock()`, `releaseLock()`, `removeStaleSocketIfAny()`.
2. `src/daemon/context.ts` — `DaemonContext` interface; stub `SessionRegistry` (Phase 2 fills in), stub idle tracker, empty resource pools.
3. `src/daemon/index.ts` — daemon main:
   - Acquire lockfile. If held by alive PID, print error + exit 1.
   - `net.createServer((socket) => acceptClient(socket, ctx))`.
   - `acceptClient`: `ndJsonStream(socket, socket)` → `new AgentSideConnection(conn => new PiAcpAgent(conn, ctx), stream)`. Wire `socket.on("close", ...)` to remove from connection set.
   - `SIGINT`/`SIGTERM` → release lock, remove socket, exit 0.
4. `src/client/auto-spawn.ts` — `autoSpawnDaemon()`, `waitForSocket()`, `tryConnect()`.
5. `src/client/index.ts` — thin-client main:
   - Compute socket path.
   - `tryConnect()`. On miss: `autoSpawnDaemon()` + `waitForSocket(3000)`.
   - Pipe stdio.
6. `src/index.ts` — mode router:
   - `--terminal-login` → existing v0.5 flow (unchanged).
   - `--daemon` → import `./daemon/index.js`.
   - `--no-daemon` OR `PI_ACP_NO_DAEMON=1` → existing v0.5 in-process path.
   - Default → `./client/index.js`.
7. `src/acp/agent.ts` — `PiAcpAgent` constructor accepts optional second arg `daemonContext?: DaemonContext`. Empty default. No behavior change in Phase 1 (Phase 2 wires SessionRegistry).
8. Tests:
   - `test/unit/socket-path.test.ts` — path resolution for Unix vs Windows (mock platform).
   - `test/component/auto-spawn.test.ts` — first client invocation spawns daemon, completes ACP `initialize`. Uses a tmpdir socket path.
   - `test/component/daemon-lifecycle.test.ts` — `--daemon` spawn, socket file appears, lockfile contains PID, SIGTERM cleans up.
   - `test/component/no-daemon-mode.test.ts` — `PI_ACP_NO_DAEMON=1` runs full v0.5 path.
9. Verify pi 0.75.3 concurrent-session safety (Q1 in PRD): spawn two clients against same daemon, each runs `session/new + session/prompt` concurrently with different cwds. Assert no model-registry / auth-storage race.

**Acceptance**: ACP wire surface unchanged from outside. Daemon hosts per-connection `PiAcpAgent`s with empty shared context. Auto-spawn works. `PI_ACP_NO_DAEMON=1` regresses to v0.5 path.

### Phase 2 — SessionRegistry + cross-window visibility

1. `src/daemon/session-registry.ts` — implementation per spec above.
2. `src/acp/agent.ts` — `newSession` / `resumeSession` / `loadSession` register into `daemonContext.sessionRegistry` if present; `closeSession` calls `release()`.
3. `src/acp/agent.ts::listSessions` — when `daemonContext` present, return union of `daemonContext.sessionRegistry.listAll()` + `SessionManager.listAll()` (disk) deduped by sessionId. Each result carries `_meta.piAcp.ownedByThisConnection`.
4. `src/acp/agent.ts::resumeSession` — when session found in `daemonContext.sessionRegistry`, add this connection to `alsoHeldBy` and return; don't re-instantiate.
5. Tests:
   - `test/component/daemon-multi-client.test.ts` — two clients connect to one daemon. Client A creates session. Client B's `session/list` includes it with `ownedByThisConnection: false`. Client B resumes it. Client A closes → session stays live. Client B closes → session disposes.
   - Disk-persisted-but-not-loaded sessions show up in `session/list`.

**Acceptance**: Cross-window `session/list` works. Refcounting prevents premature disposal.

### Phase 3 — Idle shutdown + operator commands

1. `src/daemon/idle.ts` — `IdleTracker` implementation.
2. `src/daemon/index.ts` — wire `idleTracker.bump(+1)` on accept, `idleTracker.bump(-1)` on socket close. `onIdle` = graceful shutdown.
3. `src/daemon/control.ts` — peek first frame; recognize `daemon/status` + `daemon/shutdown`. Handle inline if matched, hand off to ACP otherwise. Use a small JSON-RPC frame parser (or read-line on the socket buffer until first `\n` newline, parse, decide).
4. `src/index.ts` — `--daemon-status` / `--daemon-stop` modes:
   - Connect to socket.
   - Send corresponding JSON-RPC frame.
   - Print response / wait for shutdown / exit.
5. Tests:
   - `test/component/daemon-control.test.ts` — `--daemon-status` returns JSON; `--daemon-stop` triggers graceful shutdown.
   - Idle timeout: spawn daemon with `PI_ACP_DAEMON_IDLE_SECONDS=2`, connect, disconnect, wait 3s, verify daemon exited and socket removed.

**Acceptance**: Operator commands work. Idle shutdown fires on schedule. Manual `--daemon-stop` works.

### Phases 4+ — PRD-002 backends

Phase 4 onwards follows `plan-portable-runtime.md`. Each backend (`VirtualResourceLoader`, `LocalBackend`, manifest, `SshBackend`, `HttpBackend`, `AcpFsBackend`, `import_resource`, cwd modes, diagnostics) registers its singleton in `DaemonContext` and is constructed once by daemon startup. Per-connection `PiAcpAgent` reads from shared singletons.

`SshPool` shape (PRD-002 Phase 3-equivalent):

```ts
class SshPool {
  acquire(host: string, user: string): Promise<SshConnection>;
  // Reuses ControlMaster across calls
}
```

`HttpCache` shape:

```ts
class HttpCache {
  get(url: string, ttlMs: number): Promise<string>;
}
```

`ManifestCache` shape:

```ts
class ManifestCache {
  resolve(cwd: string): Manifest;
  // Keyed by cwd + stat-mtime of .pi-acp.yaml
}
```

`ResourceLoaderPool` shape:

```ts
class ResourceLoaderPool {
  acquire(manifestHash: string, ctx: DaemonContext): VirtualResourceLoader;
  // One loader instance per unique manifest; sessions with same effective manifest share
}
```

### Final phase — Release

1. `CHANGELOG.md` `v0.6.0` section summarizing daemon + PRD-002 work.
2. README update covering daemon mode + escape hatch + operator commands + manifest format + `import_resource` + cwd modes.
3. Bump version (semantic-release manages).
4. Tag `v0.6.0`.
5. Post-release: open issues for v0.7+ items (remote bash/edit/write, ACP `terminal/*` delegation, persistent HTTP disk cache).

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pi `0.75.3` not safe for concurrent `createAgentSession` calls in one process | Med | High | Phase 1 gate test runs two concurrent sessions. If race detected, fall back to: daemon spawns a sub-process per `AgentSession`; sub-processes share singletons via IPC. More complex but viable. |
| Auto-spawn race (two clients within ms) | Med | Low | Lockfile `O_EXCL`. Loser polls for socket. |
| Stale lockfile after daemon crash | Med | Med | PID-alive check on acquire. Reclaim if dead. |
| Idle timer fires during slow client connect | Low | Low | New connection cancels timer; connect protocol bounded; if shutdown started, accept-loop closed → client retries auto-spawn. |
| `--terminal-login` breaks because of mode-router ordering | Low | Low | `--terminal-login` checked FIRST in mode router. Tested explicitly. |
| Windows named-pipe semantics diverge | Med | Med | Wrap transport; Windows CI lane. Iterate. |
| `PI_ACP_NO_DAEMON=1` rots over time | Med | Med | CI runs full suite in both modes per push. |
| Crashing `PiAcpAgent` brings down daemon | High | High | Per-connection `uncaughtException` handler; connection-scoped try/catch boundaries. |
| One client floods socket with frames, blocking other clients | Low | Med | Backpressure: per-connection write queue with high-watermark; close offending connection. |

## Open Questions

- Q1 (PRD-003): Pi `0.75.3` concurrent session safety. Resolve in Phase 1 via gate test.
- Q2 (PRD-003): Idle timeout default 600s — verify with real-world telemetry post-release.
- Q3 (PRD-003): Per-connection vs user-level session ownership. Connection-level for v0.6.
- Q4 (PRD-003): Windows named-pipe lockfile approach. Phase 1.
- Q5 (PRD-003): Crash isolation — connection only, sessions remain in registry.
- Q6 (PRD-003): `--daemon-status` output format. JSON default + `--text` opt-in.
- Q7 (PRD-003): Daemon debug log destination. Stderr.

## ADR Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-0010](../adr/ADR-0010-daemon-client-split.md) | Split pi-acp into Long-Running Daemon + Thin-Client Binary | Accepted |
| [ADR-0006](../adr/ADR-0006-virtual-resource-loader.md) | Custom VirtualResourceLoader for Multi-Root Resource Composition | Accepted |
| [ADR-0007](../adr/ADR-0007-acp-fs-delegation.md) | Delegate read Tool to ACP Client When fs.readTextFile Capability Advertised | Accepted |
| [ADR-0008](../adr/ADR-0008-resource-composition-manifest.md) | Resource Composition Manifest | Accepted |
| [ADR-0009](../adr/ADR-0009-cwd-independence-modes.md) | Cwd Independence Modes | Accepted |
