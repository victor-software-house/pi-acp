# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction)) adapter for [`pi`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) coding agent.

`pi-acp` embeds pi directly via the `@earendil-works/pi-coding-agent` SDK and exposes it as an ACP agent over stdio. Each ACP session owns one in-process `AgentSession`.

## Specs and decisions

- [`docs/prd/PRD-001-acp-v013-zed-alignment.md`](docs/prd/PRD-001-acp-v013-zed-alignment.md) — v0.5 release PRD (Shipped).
- [`docs/prd/PRD-002-portable-runtime.md`](docs/prd/PRD-002-portable-runtime.md) — v0.6 portable runtime + multi-host resource composition (Substrate Shipped; Phases 8b/9 deferred).
- [`docs/prd/PRD-003-runtime-daemon.md`](docs/prd/PRD-003-runtime-daemon.md) — v0.6 long-running daemon + thin-client binary (Draft).
- [`docs/architecture/plan-acp-v013-zed-alignment.md`](docs/architecture/plan-acp-v013-zed-alignment.md) — v0.5 phased implementation plan.
- [`docs/architecture/plan-portable-runtime.md`](docs/architecture/plan-portable-runtime.md) — v0.6 portable-runtime plan.
- [`docs/architecture/plan-runtime-daemon.md`](docs/architecture/plan-runtime-daemon.md) — v0.6 daemon plan (foundation for portable-runtime backends).
- [`docs/adr/`](docs/adr/) — architecture decision records (ADR-0001..ADR-0010).
- [`docs/architecture/acp-conformance.md`](docs/architecture/acp-conformance.md) — ACP conformance reference.
- [`docs/architecture/claude-acp-comparison.md`](docs/architecture/claude-acp-comparison.md) — reference comparison against `claude-agent-acp`.

## Status

Active development. ACP compliance is improving steadily. Development is centered around [Zed](https://zed.dev) editor support; other ACP clients may have varying levels of compatibility.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Streams thinking output as ACP `agent_thought_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Descriptive tool titles (`Read src/index.ts`, `Run ls -la`, `Edit config.ts`)
  - Tool call locations surfaced for follow-along features in clients like Zed
  - For `edit` and `write`, emits ACP structured diffs (`oldText`/`newText`)
  - Tool kinds: `read`, `edit`, `execute` (bash), `other`
- Session configuration via ACP `configOptions`
  - Model selector (category: `model`)
  - Thinking level selector (category: `thought_level`)
  - Also advertises `modes` and `models` for backward compatibility
  - `session/set_config_option` for changing model or thinking level
  - `config_option_update` emitted when configuration changes
- Session persistence and lifecycle
  - Multiple concurrent sessions supported
  - pi manages sessions in `~/.pi/agent/sessions/...`
  - `session/list` with title fallback from first user message
  - `session/load` replays structured history (text, thinking, tool calls)
  - `closeSession`, `resumeSession` (stable in ACP v0.12.2+)
  - `unstable_forkSession` (preview)
  - Sessions can be resumed in both `pi` CLI and ACP clients
- Usage and cost tracking
  - `usage_update` emitted after each agent turn with context size and cost
  - `PromptResponse.usage` includes per-turn token counts
- Slash commands
  - File-based prompt templates from `~/.pi/agent/prompts/` and `<cwd>/.pi/prompts/`
  - Extension commands from pi extensions
  - Skill commands (appear as `/skill:skill-name`)
  - Built-in adapter commands (see below)
- Authentication via Terminal Auth (ACP Registry support)
- Startup info block with pi version and context (configurable via `quietStartup` setting)
- **Resource composition manifest** (`.pi-acp.yaml`) — PRD-002 §FR-3
  - Cascade: ACP session params > project `<cwd>/.pi-acp.yaml` > user-global `~/.pi-acp/config.yaml` > synthesized default
  - Backends: `local`, `ssh` (Bun Shell `$` + ssh self-terminate options), `http` (HTTPS-only fetch + per-URL TTL cache, default 300s)
  - Merge strategies: `append` (default) or `override-by-name` for skills and prompts
  - Opt-in diagnostics surface (`diagnostics: true`) — one-line resource summary on first prompt of each session
- **Cwd-independence modes** (PRD-002 §FR-5)
  - `local` (default) / `overlay` — ACP `params.cwd` used as session cwd; manifest roots compose
  - `none` — pi-acp mints an ephemeral tmpdir under `os.tmpdir()/pi-acp-session-*`, cleaned up at session dispose. For one-shot Q&A sessions that shouldn't pollute any project directory.
- **ACP-FS `read` delegation** (PRD-002 §FR-6) — When the client advertises `clientCapabilities.fs.readTextFile`, pi-acp routes pi's built-in `read` tool through `connection.fs.readTextFile` instead of local disk. Lets Zed Remote read the actual remote workspace files (the ones the user is editing) while pi runs locally.
- **ACP terminal delegation** (PRD-002 §FR-6.5) — When the client advertises `clientCapabilities.terminal`, pi-acp overrides pi's built-in `bash` tool with an ACP `createTerminal`-backed implementation. Commands run on the client's machine via `terminal/*` lifecycle, so Zed Remote workflows execute `bash` on the remote workspace where the user actually edits. Pairs with `read` delegation so the full read/bash pair lands consistently remote.
- **ACP provider config** — `agentCapabilities.providers = {}` advertises `providers/list`, `providers/set`, `providers/disable`. Soft-disable on top of pi's `unregisterProvider`. Per-process; no `models.json` writer.
- **ACP logout** — `agentCapabilities.auth.logout = {}` advertises `logout`. Clears every provider's credentials from the shared `AuthStorage` in one call.
- **ACP session delete** — implemented but DISABLED by default (see Limitations). Direct invocation returns `methodNotFound`; capability not advertised. Flip `PiAcpAgent.SESSION_DELETE_ENABLED` to enable.
- **ACP `extMethod` / `extNotification`** — dispatcher under the `pi-acp/` namespace. Built-ins: `pi-acp/ping`, `pi-acp/runtime-info`.

## Resource composition (`.pi-acp.yaml`)

Drop a `.pi-acp.yaml` at the project root (or `~/.pi-acp/config.yaml` for user-global defaults). Schema version `1`:

```yaml
version: 1
mode: local      # local (default) | overlay | none
mergeStrategy: append   # append | override-by-name
diagnostics: false      # true: emit a one-line resource summary on first prompt

roots:
  # Local roots (cwd + optional alt agentDir)
  - id: project
    kind: local
    paths:
      cwd: .
      agentDir: ~/.pi/agent

  # Remote files over SSH (operator's ~/.ssh/config honored end-to-end)
  - id: cvm
    kind: ssh
    host: cvm
    user: varaujo
    paths:
      agentsFiles:
        - /home/varaujo/.pi/agent/AGENTS.md
        - /workspace/team/SECURITY.md
      # skills/prompts/extensions over SSH not yet implemented;
      # declaring paths.skills here emits a diagnostic at session start.

  # Public HTTPS fetch (e.g. team's shared AGENTS file on a public repo)
  - id: team
    kind: http
    baseUrl: https://raw.githubusercontent.com/team/dotfiles/main
    cache:
      ttl: 600   # per-URL TTL in seconds; default 300, 0 disables
    paths:
      agentsFiles:
        - AGENTS.md
```

Cascade precedence (highest first):

1. ACP session params: `params._meta.piAcp.manifest` (inline manifest object OR string path to a YAML file)
2. Project: `<cwd>/.pi-acp.yaml`
3. User-global: `~/.pi-acp/config.yaml`
4. Synthesized default (single implicit local root)

## Prerequisites

- Node.js 24+ (hard requirement, matches pi runtime)
- `pi` installed globally (v0.75.3+): `npm install -g @earendil-works/pi-coding-agent`
- Configure `pi` for your model providers/API keys

## Install

### ACP Registry (Zed)

Launch the registry with `zed: acp registry` and select `pi ACP`:

```json
"agent_servers": {
  "pi-acp": {
    "type": "registry"
  }
}
```

### npx (no global install)

```json
"agent_servers": {
  "pi": {
    "type": "custom",
    "command": "npx",
    "args": ["-y", "@victor-software-house/pi-acp"],
    "env": {}
  }
}
```

### Global install

```bash
npm install -g @victor-software-house/pi-acp
```

```json
"agent_servers": {
  "pi": {
    "type": "custom",
    "command": "pi-acp",
    "args": [],
    "env": {}
  }
}
```

### From source

```bash
bun install
bun run build
```

```json
"agent_servers": {
  "pi": {
    "type": "custom",
    "command": "node",
    "args": ["/path/to/pi-acp/dist/index.js"],
    "env": {}
  }
}
```

## Built-in commands

- `/compact [instructions...]` -- compact session context
- `/autocompact on|off|toggle` -- toggle automatic compaction
- `/export` -- export session to HTML
- `/session` -- show session stats (tokens, messages, cost)
- `/name <name>` -- set session display name
- `/steering all|one-at-a-time` -- set steering message delivery mode
- `/follow-up all|one-at-a-time` -- set follow-up message delivery mode
- `/changelog` -- show pi changelog

## Authentication

Terminal Auth for the [ACP Registry](https://agentclientprotocol.com/get-started/registry):

```bash
pi-acp --terminal-login
```

Zed shows an Authenticate banner that launches this automatically.

## Development

```bash
bun install
bun run dev          # run from src
bun run build        # tsdown -> dist/index.mjs
bun run typecheck    # tsc --noEmit
bun run lint         # biome + oxlint
bun test             # 308 tests
```

Project layout:

```
src/
  index.ts                  # stdio entry point
  env.d.ts                  # ProcessEnv augmentation
  acp/
    agent.ts                # PiAcpAgent (ACP Agent interface)
    session.ts              # PiAcpSession (wraps AgentSession, translates events)
    auth.ts                 # AuthMethod builder
    auth-required.ts        # auth error detection
    pi-settings.ts          # settings reader (Zod schema)
    translate/
      pi-messages.ts        # pi message text extraction
      pi-tools.ts           # pi tool result text extraction (Zod schema)
      prompt.ts             # ACP ContentBlock -> pi message
  pi-auth/
    status.ts               # auth detection (Zod schema)
test/
  helpers/fakes.ts          # test doubles
  unit/                     # unit tests
  component/                # integration tests
```

## Limitations

### MUST-level gaps

- **MCP servers** -- accepted in `session/new` and `session/load` params but not wired through to pi. ACP requires agents to connect to all provided MCP servers. This is the main compliance gap (upstream pi SDK limitation).

### SHOULD-level gaps

- **`session/request_permission`** -- pi does not request permission from ACP clients before tool execution.

### Not implemented (MAY / client capabilities)

- **`agent_plan`** -- plan updates not emitted before tool execution. pi has no equivalent planning surface.
- **ACP filesystem `write` delegation** (`fs/write_text_file`) -- pi writes locally. Not advertised. `fs/read_text_file` IS routed through ACP when the client advertises the capability (see Features → ACP-FS `read` delegation).
- **ACP terminal delegation** (`terminal/*`) -- DELEGATED. When the client advertises `clientCapabilities.terminal`, pi-acp overrides pi's built-in `bash` tool with an ACP `createTerminal`-backed implementation so commands run on the client's machine (Zed Remote routes `terminal/*` to the remote workspace). See Features → ACP terminal delegation.

### ACP optional methods implemented (substrate completion at v0.16.0+)

- **`providers/list` / `providers/set` / `providers/disable`** -- advertised via `agentCapabilities.providers = {}`. Operates on every live `ModelRegistry`. Soft-disable is layered on top of pi's destructive `unregisterProvider`. Mutations are per-process (no models.json writer in pi).
- **`logout`** -- advertised via `agentCapabilities.auth.logout = {}`. Clears every provider's credentials from the shared AuthStorage. Sessions stay live; subsequent prompts may surface `auth_required`.
- **`extMethod` / `extNotification`** -- dispatcher under the `pi-acp/` method-name namespace. Built-in handlers: `pi-acp/ping`, `pi-acp/runtime-info`. Unknown methods → `methodNotFound`.

### Implemented but DISABLED by default

- **`session/delete`** -- the implementation (release-from-daemon → `fs.rmSync` → cache purge) is in place, but the capability is NOT advertised in `initialize()` and direct invocations return `methodNotFound`. Gated behind `PiAcpAgent.SESSION_DELETE_ENABLED = false`. Rationale: ACP `session/delete` takes a single sessionId, has no confirmation surface, no trash, no recovery — easy to misfire from a UI button or a mistaken script. Re-enable only after a client-layer confirmation flow exists.

### Design decisions

- pi does not have real session modes (ask/architect/code). The `modes` field exposes thinking levels for backward compatibility with clients that do not support `configOptions`.
- `configOptions` is the preferred configuration mechanism. Zed uses it exclusively when present.
- pi-acp uses direct filesystem access rather than delegating reads/writes to the ACP client. This means pi reads on-disk file versions, not unsaved editor buffers.

See [docs/architecture/acp-conformance.md](docs/architecture/acp-conformance.md) for detailed conformance status.

## Release

Releases are automated via [semantic-release](https://semantic-release.gitbook.io/) on pushes to `main`. The pipeline runs typecheck, lint, tests, and `npm pack --dry-run` before publishing. npm trusted publishing (OIDC) is used -- no long-lived npm tokens.

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/). Commitlint enforces this locally via lefthook and in CI.

## License

MIT (see [LICENSE](LICENSE)).

---

Inspired by [svkozak/pi-acp](https://github.com/svkozak/pi-acp).
