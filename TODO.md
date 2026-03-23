# TODO

Execution checklist for the `PLAN.md` refactor.

Legend:

- [ ] not started
- [x] done

## Phase 1: Correct session lifecycle

- [ ] Remove single-live-session eviction (`closeAllExcept(...)`) from normal new/load flows
- [ ] Support multiple active `PiAcpSession` instances concurrently
- [ ] Add `unstable_closeSession`
- [ ] Add `unstable_resumeSession`
- [ ] Add `unstable_forkSession`
- [ ] Keep session ID to file-path resolution correct across new/load/resume/fork/close
- [ ] Add tests for multiple concurrent sessions
- [ ] Add tests for close/resume/fork behavior

## Phase 2: High-fidelity replay and live output

- [ ] Refactor assistant replay to preserve structured content, not only flattened text
- [ ] Replay assistant text blocks as `agent_message_chunk`
- [ ] Replay assistant thinking blocks as `agent_thought_chunk`
- [ ] Replay persisted tool calls as ACP tool calls instead of synthesizing generic completed calls
- [ ] Preserve replayed tool `rawInput` where available
- [ ] Preserve replayed tool `locations` where available
- [ ] Improve live tool titles from tool args
- [ ] Improve replayed tool titles from persisted data
- [ ] Improve tool `kind` mapping and keep it stable across live/replay paths
- [ ] Emit ACP-native diff content for `write` tool calls when args contain new file content
- [ ] Tighten `edit` diff rendering so live and replay paths match more closely
- [ ] Stop flattening structured tool results to plain text too early
- [ ] Add tests for replay fidelity
- [ ] Add tests for richer tool titles, kinds, locations, and diff content

## Phase 3: Usage and capability parity

- [ ] Emit `usage_update` notifications after completed assistant turns
- [ ] Return `PromptResponse.usage`
- [ ] Populate token fields from pi usage data
- [ ] Populate cumulative cost from pi usage/session stats
- [ ] Populate context size from the active pi model context window
- [ ] Set `promptCapabilities.embeddedContext = true`
- [ ] Tighten ACP resource and resource-link translation
- [ ] Add tests for usage updates
- [ ] Add tests for prompt usage response
- [ ] Add tests for embedded resource handling

## Phase 4: Terminal rendering improvement

- [ ] Detect client support for terminal output metadata
- [ ] Emit ACP terminal content for bash tool calls when supported
- [ ] Emit `_meta.terminal_info` for bash tool start
- [ ] Emit `_meta.terminal_output` for bash output updates
- [ ] Emit `_meta.terminal_exit` for bash completion
- [ ] Keep plain-text fallback for clients without terminal support
- [ ] Add tests for terminal metadata lifecycle

## Phase 5: Error and auth hardening

- [ ] Wire in runtime auth error detection
- [ ] Map runtime auth failures to ACP `authRequired`
- [ ] Improve internal error mapping for session creation
- [ ] Improve internal error mapping for session loading
- [ ] Improve internal error mapping for prompt execution
- [ ] Standardize unknown-session handling across load/resume/close/prompt/cancel
- [ ] Add tests for auth-required error mapping
- [ ] Add tests for invalid-session handling

## Phase 6: UX polish

- [ ] Improve session list titles using session name or a message-derived fallback
- [ ] Emit synchronized config updates for thinking-level changes
- [ ] Return concrete empty response objects instead of `void` where appropriate
- [ ] Review startup/update-notice behavior for avoidable overhead
- [ ] Add tests for session title fallback behavior
- [ ] Add tests for config update parity

## Phase 7: Tests and conformance documentation

- [ ] Add protocol-surface tests for `initialize`
- [ ] Add protocol-surface tests for `authenticate`
- [ ] Add protocol-surface tests for `session/new`
- [ ] Add protocol-surface tests for `session/load`
- [ ] Add protocol-surface tests for `session/list`
- [ ] Add protocol-surface tests for `session/prompt`
- [ ] Add protocol-surface tests for `setSessionConfigOption`
- [ ] Add protocol-surface tests for `setSessionMode`
- [ ] Add protocol-surface tests for `unstable_setSessionModel`
- [ ] Add tests for `available_commands_update`
- [ ] Add tests for `config_option_update`
- [ ] Add `docs/engineering/` conformance notes for ACP coverage and remaining limitations
- [ ] Update README limitations after implementation work lands

## Confirmed exclusions for this refactor

These are intentionally out of scope unless upstream pi changes.

- [ ] Do not implement ACP `session/request_permission` in this refactor
- [ ] Do not synthesize ACP `plan` / TODO updates without a real pi equivalent
- [ ] Do not add ACP filesystem delegation (`readTextFile` / `writeTextFile`) in this refactor
- [ ] Do not add ACP terminal delegation RPC methods in this refactor
- [ ] Do not claim ACP per-session MCP wiring support until the pi SDK exposes it
