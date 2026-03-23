# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction)) adapter for [`pi`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) coding agent.

`pi-acp` embeds pi directly via the `@mariozechner/pi-coding-agent` SDK and exposes it as an ACP agent over stdio. Each ACP session owns one in-process `AgentSession`.

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
  - `unstable_closeSession`, `unstable_resumeSession`, `unstable_forkSession`
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

## Prerequisites

- Node.js 20+
- `pi` installed globally: `npm install -g @mariozechner/pi-coding-agent`
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
bun test             # 26 tests
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
- **ACP filesystem delegation** (`fs/read_text_file`, `fs/write_text_file`) -- pi reads/writes locally. Not advertised.
- **ACP terminal delegation** (`terminal/*`) -- pi executes commands locally. Not advertised.

### Design decisions

- pi does not have real session modes (ask/architect/code). The `modes` field exposes thinking levels for backward compatibility with clients that do not support `configOptions`.
- `configOptions` is the preferred configuration mechanism. Zed uses it exclusively when present.
- pi-acp uses direct filesystem access rather than delegating reads/writes to the ACP client. This means pi reads on-disk file versions, not unsaved editor buffers.

See [docs/engineering/acp-conformance.md](docs/engineering/acp-conformance.md) for detailed conformance status.

## Release

Releases are automated via [semantic-release](https://semantic-release.gitbook.io/) on pushes to `main`. The pipeline runs typecheck, lint, tests, and `npm pack --dry-run` before publishing. npm trusted publishing (OIDC) is used -- no long-lived npm tokens.

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/). Commitlint enforces this locally via lefthook and in CI.

## License

MIT (see [LICENSE](LICENSE)).

---

Inspired by [svkozak/pi-acp](https://github.com/svkozak/pi-acp).
