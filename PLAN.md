# PLAN

Refactor `pi-acp` from a minimum-viable ACP adapter into a higher-fidelity ACP implementation for Zed and other ACP clients.

This plan covers only adapter work. It excludes features that require upstream pi SDK support or a deeper change to pi's execution model.

## Goals

1. Support multiple live ACP sessions correctly.
2. Improve session replay fidelity so loaded sessions render like live sessions.
3. Expose richer ACP-native tool output for better external rendering.
4. Expose token usage and cost data that pi already provides.
5. Close protocol gaps that are implementable in the adapter.
6. Add test coverage for the expanded ACP surface.

## Scope

### In scope

- multi-session support
- `unstable_closeSession`
- `unstable_resumeSession`
- `unstable_forkSession`
- richer tool titles, kinds, locations, and content
- higher-fidelity history replay
- `usage_update` notifications
- `PromptResponse.usage`
- `embeddedContext` capability
- terminal-style metadata for bash tool rendering
- stronger auth and runtime error mapping
- protocol and component test coverage
- conformance documentation updates

### Out of scope

These are intentionally excluded from this refactor.

- ACP `session/request_permission`
  - pi currently owns tool execution and approval behavior internally.
  - Matching Claude ACP here would require a permission-gate architecture, not just adapter changes.
- ACP plan parity (`plan` / TODO-style updates)
  - pi does not expose a first-class TodoWrite-style planning surface equivalent to Claude Code.
  - Synthesizing plan updates would be invented behavior, not a faithful adapter mapping.
- ACP filesystem delegation (`readTextFile` / `writeTextFile`)
  - pi's built-in tools operate on disk directly.
  - Delegation would require a client-backed virtual filesystem or deeper tool interception.
- ACP terminal delegation (`terminal/create`, `terminal/release`, and related RPC methods)
  - pi executes commands locally.
  - This refactor only adds better terminal rendering metadata for local bash execution.
- ACP-provided MCP server wiring via `session/new` / `session/load`
  - The published pi SDK surface for `createAgentSession()` does not expose ACP-style per-session `mcpServers` wiring.
  - This remains an upstream SDK limitation until pi exposes it.

## Design decisions

### Keep direct filesystem access

`pi-acp` will continue to use pi's local filesystem tools rather than delegating file reads and writes to the ACP client.

Implications:

- pi reads the on-disk version of files, not unsaved editor buffers
- Zed still learns about file changes through filesystem watching
- no editor round-trip is required for each file operation
- this stays aligned with pi's current architecture

This is an intentional design choice, not an accidental omission.

### Keep pi as the execution owner

`pi-acp` adapts pi's runtime into ACP. It does not try to move execution ownership into the ACP client. That means:

- tool permission prompting stays out of scope
- terminal execution stays local to pi
- plan updates are only added if pi exposes a real corresponding concept

## Current deficiencies to address

### Session model

- only one live session is effectively supported because creating or loading a session closes all others
- no explicit ACP session close operation is exposed
- no ACP resume or fork support is exposed

### Replay fidelity

- session replay is text-heavy and reconstructs tool activity only loosely
- replayed tool calls lose structured input and richer rendering opportunities
- thinking output is not replayed
- image and richer content replay is incomplete

### Tool rendering

- tool titles are generic (`bash`, `read`, `edit`, `write`)
- `write` and `edit` do not expose as much ACP-native diff content as they could
- tool results are flattened to text too early
- bash output does not expose terminal-style metadata for clients that can render it

### Usage and capability reporting

- no `usage_update` notifications are emitted
- `PromptResponse.usage` is not returned
- `embeddedContext` is advertised as unsupported even though prompt translation already handles resource blocks

### Error handling

- runtime auth errors are not consistently translated to ACP `authRequired`
- some failures are surfaced too generically

### Test coverage

- limited protocol-surface tests
- no multi-session tests
- no tests for usage updates, terminal metadata, resume/fork/close, or replay fidelity

## Refactoring phases

### Phase 1: Correct session lifecycle

Objective: support ACP session lifecycle correctly.

Tasks:

- remove single-live-session eviction behavior
- keep multiple `PiAcpSession` instances active simultaneously
- add `unstable_closeSession`
- add `unstable_resumeSession`
- add `unstable_forkSession`
- ensure session bookkeeping remains correct across new, load, resume, fork, close

Acceptance criteria:

- opening a second session does not invalidate the first
- closing a session disposes only that session
- resuming an already-live session reuses it correctly
- forking creates a new ACP session backed by a new pi session file

### Phase 2: High-fidelity replay and live output

Objective: make loaded sessions render like live ones and improve live tool rendering.

Tasks:

- translate persisted assistant content block-by-block during replay
- replay text, thinking, and tool calls instead of only flattened text
- preserve tool call `rawInput`, `kind`, `title`, and `locations`
- improve live tool titles from tool args
- emit ACP-native diff content for write and edit operations where possible
- stop collapsing structured tool results to plain text too early

Acceptance criteria:

- replayed sessions expose structured tool calls and richer assistant output
- read/edit/write/bash tool calls render with descriptive titles
- write and edit activity exposes diff content when available

### Phase 3: Usage and capability parity

Objective: expose information pi already knows.

Tasks:

- emit `usage_update` notifications after completed assistant turns
- include `usage` in `PromptResponse`
- use pi session/model data to populate token counts, cost, and context size
- advertise `embeddedContext: true`
- tighten resource and resource-link prompt translation

Acceptance criteria:

- ACP clients receive cumulative usage updates during a session
- prompt responses include per-turn usage data when available
- embedded resource blocks are accepted and correctly translated

### Phase 4: Terminal rendering improvement

Objective: improve bash rendering without introducing terminal delegation.

Tasks:

- detect client support for terminal output extensions
- emit terminal-style tool content for bash tool calls
- emit `_meta.terminal_info`, `_meta.terminal_output`, and `_meta.terminal_exit` where supported
- retain plain-text fallback for clients without terminal support

Acceptance criteria:

- clients that understand terminal metadata render bash execution more richly
- fallback behavior remains correct for clients without that support

### Phase 5: Error and auth hardening

Objective: surface failures more accurately.

Tasks:

- wire in runtime auth error detection
- map auth failures to ACP `authRequired`
- improve internal/runtime error mapping for session creation, loading, and prompt execution
- tighten unknown-session handling across all session lifecycle methods

Acceptance criteria:

- auth failures are surfaced as `authRequired` where appropriate
- invalid session IDs are reported consistently
- generic internal errors are reduced

### Phase 6: UX polish

Objective: remove remaining MVP-level rough edges.

Tasks:

- improve session list titles using session name or message-derived fallback
- tighten config update parity across mode/thinking-level changes
- return concrete empty responses instead of `void` where appropriate
- reduce avoidable startup overhead such as repeated update checks where possible

Acceptance criteria:

- session lists no longer show blank titles for unnamed sessions
- config updates stay synchronized across the ACP surface
- no avoidable response-shape inconsistencies remain

### Phase 7: Tests and conformance documentation

Objective: make regressions less likely and document remaining gaps clearly.

Tasks:

- add protocol-surface tests for initialize, new, load, list, prompt, and config changes
- add component tests for replay fidelity
- add tests for multi-session behavior
- add tests for usage updates and terminal metadata
- document conformance status and remaining upstream limitations

Acceptance criteria:

- the expanded ACP surface is covered by tests
- remaining exclusions are documented as intentional or upstream-limited

## Remaining upstream limitations

These should remain tracked until pi exposes the necessary SDK surface.

1. Per-session ACP MCP server wiring through `createAgentSession()`.
2. A real ACP-style permission approval bridge.
3. A real plan/TODO surface from pi that can be mapped to ACP `plan` updates.
4. Client-delegated filesystem and terminal ownership.

## Suggested implementation order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7

This order front-loads correctness and rendering improvements before polish and documentation.
