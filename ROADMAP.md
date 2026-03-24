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

## P2 -- Correctness and UX Improvements -- DONE

- [x] Reference cleanup and ownership tightening -- removed startup banner, update-check code, `quietStartup` gating, replaced `readNearestPackageJson()` with JSON import, replaced `builtinAvailableCommands()` with `BUILTIN_COMMANDS` const, removed dead `toolResultToText()`
- [x] `markdownEscape` dynamic backtick fence wrapping -- replaced character-level escaping with fence wrapping that auto-adjusts to content
- [x] Model alias resolution -- `resolveModelPreference()` with tokenized matching, context hints (e.g. `sonnet[3.5]`), non-numeric match requirement
- [x] Separate `terminal_output` from `terminal_exit` -- two separate emissions on tool end for proper Zed rendering
- [x] Prompt queueing -- `promptRunning` flag + `pendingMessages` queue, dequeue on turn completion, cancel resolves all pending
- [x] Exhaustive event handling -- `unreachable()` helper replaces `default: break` in `handlePiEvent`

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
