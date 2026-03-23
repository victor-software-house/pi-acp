# TODO

Execution checklist for the `PLAN.md` refactor.

Legend:

- [ ] not started
- [x] done

## Phase 1: Correct session lifecycle

- [x] Remove single-live-session eviction (`closeAllExcept(...)`) from normal new/load flows
- [x] Support multiple active `PiAcpSession` instances concurrently
- [x] Add `unstable_closeSession`
- [x] Add `unstable_resumeSession`
- [x] Add `unstable_forkSession`
- [x] Keep session ID to file-path resolution correct across new/load/resume/fork/close
- [x] Add tests for multiple concurrent sessions
- [x] Add tests for close/resume/fork behavior

## Phase 2: High-fidelity replay and live output

- [x] Refactor assistant replay to preserve structured content, not only flattened text
- [x] Replay assistant text blocks as `agent_message_chunk`
- [x] Replay assistant thinking blocks as `agent_thought_chunk`
- [x] Replay persisted tool calls as ACP tool calls instead of synthesizing generic completed calls
- [x] Preserve replayed tool `rawInput` where available
- [x] Preserve replayed tool `locations` where available
- [x] Improve live tool titles from tool args
- [x] Improve replayed tool titles from persisted data
- [x] Improve tool `kind` mapping and keep it stable across live/replay paths
- [x] Emit ACP-native diff content for `write` tool calls when args contain new file content
- [x] Tighten `edit` diff rendering so live and replay paths match more closely
- [x] Stop flattening structured tool results to plain text too early
- [x] Add tests for replay fidelity
- [x] Add tests for richer tool titles, kinds, locations, and diff content

## Phase 3: Usage and capability parity

- [x] Emit `usage_update` notifications after completed assistant turns
- [x] Return `PromptResponse.usage`
- [x] Populate token fields from pi usage data
- [x] Populate cumulative cost from pi usage/session stats
- [x] Populate context size from the active pi model context window
- [x] Set `promptCapabilities.embeddedContext = true`
- [x] Tighten ACP resource and resource-link translation
- [x] Add tests for usage updates
- [x] Add tests for prompt usage response
- [x] Add tests for embedded resource handling

## Phase 4: Terminal rendering improvement (deferred)

No ACP client currently consumes custom `_meta.terminal_*` extensions.
Deferred until a client signals support or the ACP spec standardizes terminal content.

- [ ] Detect client support for terminal output metadata
- [ ] Emit ACP terminal content for bash tool calls when supported
- [ ] Emit `_meta.terminal_info` for bash tool start
- [ ] Emit `_meta.terminal_output` for bash output updates
- [ ] Emit `_meta.terminal_exit` for bash completion
- [ ] Keep plain-text fallback for clients without terminal support
- [ ] Add tests for terminal metadata lifecycle

## Phase 5: Error and auth hardening

- [x] Wire in runtime auth error detection
- [x] Map runtime auth failures to ACP `authRequired`
- [x] Improve internal error mapping for session creation
- [x] Improve internal error mapping for session loading
- [x] Improve internal error mapping for prompt execution
- [x] Standardize unknown-session handling across load/resume/close/prompt/cancel
- [x] Add tests for auth-required error mapping
- [x] Add tests for invalid-session handling

## Phase 6: UX polish

- [x] Improve session list titles using session name or a message-derived fallback
- [x] Emit synchronized config updates for thinking-level changes
- [x] Return concrete empty response objects instead of `void` where appropriate
- [x] Review startup/update-notice behavior for avoidable overhead
- [x] Add tests for session title fallback behavior
- [x] Add tests for config update parity

## Phase 7: Tests and conformance documentation

- [x] Add protocol-surface tests for `initialize`
- [x] Add protocol-surface tests for `authenticate`
- [x] Add protocol-surface tests for `session/new`
- [x] Add protocol-surface tests for `session/load`
- [x] Add protocol-surface tests for `session/list`
- [ ] Add protocol-surface tests for `session/prompt` (requires DI or integration test)
- [ ] Add protocol-surface tests for `setSessionConfigOption` (requires active session)
- [ ] Add protocol-surface tests for `setSessionMode` (requires active session)
- [ ] Add protocol-surface tests for `unstable_setSessionModel` (requires active session)
- [ ] Add tests for `available_commands_update` (requires active session)
- [ ] Add tests for `config_option_update` (requires active session)
- [x] Add `docs/engineering/` conformance notes for ACP coverage and remaining limitations
- [x] Update README limitations after implementation work lands

## Confirmed exclusions for this refactor

These are intentionally out of scope unless upstream pi changes.

- [ ] Do not implement ACP `session/request_permission` in this refactor
- [ ] Do not synthesize ACP `plan` / TODO updates without a real pi equivalent
- [ ] Do not add ACP filesystem delegation (`readTextFile` / `writeTextFile`) in this refactor
- [ ] Do not add ACP terminal delegation RPC methods in this refactor
- [ ] Do not claim ACP per-session MCP wiring support until the pi SDK exposes it
