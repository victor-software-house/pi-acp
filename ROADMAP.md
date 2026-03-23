# Roadmap

## P0 -- Ship

- [x] Publish to npm as `@victor-software-house/pi-acp`
- [ ] Verify `npx @victor-software-house/pi-acp` works with Zed
- [x] Fix README Limitations section (see TODO.md)

## P1 -- Tool Output and Protocol Conformance (v0.3.0)

- [x] Phase 1: per-tool output formatting (bash console fences, read markdown-escape, lsp code fences, error code fences)
- [x] Phase 2: terminal content lifecycle (terminal_info, terminal_output, terminal_exit with cwd)
- [x] Phase 3: tool call `_meta.piAcp.toolName` on all emissions, lsp/tmux/context tool kinds and titles
- [x] Phase 4: client capabilities detection and auth method gating
- [x] Phase 5: streaming bash output formatting (console fences and terminal_output)
- [x] Phase 6: test coverage for protocol surface and tool output

## P2 -- Correctness and UX Improvements

Derived from comparison with `zed-industries/claude-agent-acp`.

- [ ] **Reference cleanup and ownership tightening** -- remove the startup banner, startup-info `_meta`, `quietStartup` ACP gating, and runtime update-check helpers (`buildUpdateNotice`, `isSemver`, `compareSemver`). Keep builtin ACP command execution for commands that pi's in-process `AgentSession` does not execute itself (`/compact`, `/session`, `/name`, `/export`, `/autocompact`, `/steering`, `/follow-up`, `/changelog`). Rewrite local command advertisement as static adapter data plus dynamic command discovery from prompts, skills, and extension commands.
- [ ] **Fix `markdownEscape` to use dynamic backtick fence wrapping** -- the current character-level escape approach fails on files containing backtick sequences, indented code blocks, blockquotes, and list markers. claude-agent-acp wraps the entire text in a dynamically-sized backtick fence that auto-adjusts to escape any backtick sequences in the content. This is simpler and strictly more correct.
- [ ] **Model alias resolution** -- let users type friendly model names like "opus", "sonnet", or "opus[1m]" in `setSessionConfigOption` and `unstable_setSessionModel`. Port the tokenized matching and scoring approach from claude-agent-acp's `resolveModelPreference()`. Currently pi-acp requires exact `provider/modelId` strings.
- [ ] **Separate `terminal_output` notification from `terminal_exit`** -- claude-agent-acp emits `terminal_output` as a separate `tool_call_update` notification (meta only, no content) before the final `tool_call_update` with `terminal_exit` and `status: completed`. pi-acp currently merges terminal_exit into the same emission as the final status. The separate notification ensures Zed renders output before exit status.
- [ ] **Prompt queueing** -- support submitting a second prompt while the first is still executing. claude-agent-acp uses a `promptRunning` flag and `pendingMessages` map to queue prompts and resolve them in order. pi-acp currently blocks on the active turn.
- [ ] **Exhaustive event handling with `unreachable()` helper** -- claude-agent-acp uses an `unreachable()` function for exhaustive switch/case checking that logs unknown message types. pi-acp silently ignores unknown events with `default: break`, hiding potential protocol evolution or SDK changes.

## P3 -- MCP Server Wiring

- [ ] Wire `mcpServers` from `session/new` and `session/load` through to `createAgentSession()`
- [ ] Test with at least one MCP server (e.g. filesystem)
- [ ] This is the main remaining MUST-level ACP compliance gap

## P4 -- Optional ACP Features (blocked on pi SDK)

- [ ] `session/request_permission` -- hook into pi extension system (follow claude-agent-acp `canUseTool()` pattern)
- [ ] `session_info_update` -- automatic emission for metadata changes beyond `/name`
- [ ] `agent_plan` updates (follow codex-acp `update_plan()` pattern)
- [ ] `readTextFile` / `writeTextFile` delegation (follow claude-agent-acp delegate pattern)
- [ ] ACP terminal delegation
