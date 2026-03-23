# pi-acp (ACP adapter for pi-coding-agent)

This repository implements an **Agent Client Protocol (ACP)** adapter for **pi** (`@mariozechner/pi-coding-agent`) without modifying pi.

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- Pi side: direct `AgentSession` embedding via `createAgentSession()` from `@mariozechner/pi-coding-agent`

## Architecture

Each ACP session owns one in-process `AgentSession`. No subprocess bridge.

### Key mappings

- `session/new` -> `createAgentSession({ cwd })`
- `session/load` -> `SessionManager.open(path)` + `createAgentSession({ sessionManager })`
- `session/prompt` -> `AgentSession.prompt()` with direct event subscription
- `session/cancel` -> `AgentSession.abort()`
- `session/list` -> `SessionManager.list(cwd)` / `SessionManager.listAll()`
- `session/set_config_option` -> `AgentSession.setModel()` / `AgentSession.setThinkingLevel()`
- `session/set_mode` -> `AgentSession.setThinkingLevel()` (backward compat)
- `unstable_setSessionModel` -> `AgentSession.setModel()` (backward compat)

### Config options

Two ACP config options via `configOptions` in session responses:

- `model` (category: `model`) -- model selector from `ModelRegistry.getAvailable()`
- `thought_level` (category: `thought_level`) -- from `AgentSession.getAvailableThinkingLevels()`

Both `modes` and `models` are also returned for backward compatibility.

## Dev workflow

- Install deps: `bun install`
- Run in dev: `bun run dev`
- Build: `bun run build`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint` (biome + oxlint)
- Test: `bun test`

## Coding guidelines

- Toolchain: Bun (dev/test), tsdown (npm build), Biome (format/lint), oxlint (type-aware lint + zod plugin)
- Tabs, double quotes, semicolons, `import type` enforced, `node:` protocol
- No `any`, no unsafe type assertions (`as Type`), no `@ts-ignore`
- Zod for parsing untrusted/external data (JSON files, pi SDK `any` boundaries)
- Plain `in` narrowing for trusted local data (no Zod overhead on hot paths)
- `.parse()` inside try/catch; `.safeParse()` only when handling failure branch explicitly
- Strict TS: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`
- Explicit null/undefined comparisons -- no truthy coercion on nullable strings

## Conformance

See [TODO.md](TODO.md) for gap inventory, [ROADMAP.md](ROADMAP.md) for priorities.

## Source control

- **DO NOT** commit unless explicitly asked!

## Client information

- Current ACP client is Zed

## References

- ACP spec: https://agentclientprotocol.com/llms.txt
- ACP schema: https://agentclientprotocol.com/protocol/schema.md
- Reference implementations: `zed-industries/claude-agent-acp`, `zed-industries/codex-acp`
- pi-mono: https://github.com/badlogic/pi-mono
