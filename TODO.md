# TODO

Gap inventory derived from comparison with `zed-industries/claude-agent-acp`.
See `docs/engineering/claude-acp-comparison.md` for the full analysis.

Legend:

- [ ] not started
- [x] done

---

## Phase A: Fix tool output rendering (critical)

Bash output is invisible/collapsed in Zed because pi-acp sends raw text
without formatting. Claude ACP wraps bash output in `` ```console `` code
fences and provides per-tool result formatting.

- [ ] Replace generic `toolResultToText()` with per-tool content formatters
- [ ] Bash results: wrap output in `` ```console\n{output}\n``` `` code fence
- [ ] Bash results: extract stdout/stderr separately, include exit code on non-zero
- [ ] Bash errors: wrap in `` ```\n{error}\n``` `` code fence with `status: "failed"`
- [ ] Read results: apply markdown escaping to prevent file content rendering as markdown
- [ ] Read results: preserve structured content blocks (text, images) from pi tool results
- [ ] Error results (all tools): wrap error text in code fences for visual distinction
- [ ] Emit per-tool formatted content in both `handleToolEnd` (live) and replay paths
- [ ] Add tests for bash output formatting (normal, error, empty output)
- [ ] Add tests for read output formatting with markdown-sensitive content
- [ ] Add tests for error output formatting across tool types

## Phase B: Terminal content lifecycle

Zed supports terminal rendering via `_meta.terminal_*` extensions. Both
claude-agent-acp and codex-acp implement the 3-phase lifecycle. Even without
terminal support, the `` ```console `` fallback is necessary.

- [ ] Store `clientCapabilities` from `initialize` request on the agent instance
- [ ] Detect `clientCapabilities._meta.terminal_output === true`
- [ ] When terminal output IS supported:
  - [ ] Emit `tool_call` with `content: [{ type: "terminal", terminalId }]` and `_meta.terminal_info`
  - [ ] Emit `tool_call_update` with `_meta.terminal_output` for bash streaming data
  - [ ] Emit `tool_call_update` with `_meta.terminal_exit` on bash completion (exit_code, signal)
- [ ] When terminal output is NOT supported:
  - [ ] Use `` ```console `` code fence fallback (Phase A)
- [ ] Pass terminal support flag through to `PiAcpSession`
- [ ] Add tests for terminal lifecycle (info -> output -> exit)
- [ ] Add tests for fallback to code fences when terminal not supported

## Phase C: Tool call metadata (`_meta`)

Claude ACP includes `_meta.claudeCode.toolName` on every tool_call and
tool_call_update. Zed may use this for icon selection or rendering mode.

- [ ] Add `_meta` with tool name to `tool_call` emissions in `handleMessageUpdate`
- [ ] Add `_meta` with tool name to `tool_call` emissions in `handleToolStart`
- [ ] Add `_meta` with tool name to `tool_call_update` emissions in `handleToolUpdate`
- [ ] Add `_meta` with tool name to `tool_call_update` emissions in `handleToolEnd`
- [ ] Add `_meta` with tool name to replayed tool calls in `replaySessionHistory`
- [ ] Use `piAcp` namespace (not `claudeCode`) for `_meta` fields
- [ ] Add tests for `_meta` presence on tool call emissions

## Phase D: Streaming bash output formatting

pi-acp already streams bash output incrementally via `tool_execution_update`
events (pi's `onUpdate` callback). But the streaming content is unformatted.

- [ ] Format streaming bash output in `handleToolUpdate` as `` ```console `` code fence
- [ ] Handle the update-vs-replace semantics: each update replaces the previous
      content (pi sends rolling tail buffer), so wrap each update independently
- [ ] Verify Zed renders `tool_call_update` content replacements correctly
- [ ] Add tests for streaming bash output formatting

## Phase E: Read tool content handling

- [ ] Implement `markdownEscape()` for read tool results (escape headings,
      links, code fences, HTML tags in file content)
- [ ] Handle image content blocks from read results (pi supports reading images)
- [ ] Preserve line offset information in read result content when available
- [ ] Add tests for markdown escaping edge cases

## Phase F: Client capabilities

Claude ACP stores and uses `clientCapabilities` for feature detection and
auth method selection. pi-acp currently ignores them.

- [ ] Store `clientCapabilities` from `initialize` on the `PiAcpAgent` instance
- [ ] Pass relevant capabilities to `PiAcpSession` on creation
- [ ] Use `_meta.terminal_output` for terminal content lifecycle (Phase B)
- [ ] Use `auth.terminal` and `_meta.terminal-auth` for auth method selection
- [ ] Expose capability flags via a typed interface (not raw object access)
- [ ] Add tests for capability detection and feature toggling

## Phase G: Protocol test coverage

Remaining test gaps from v0.2.0. These require an active session with a
real or sufficiently faked `AgentSession`.

- [ ] Add protocol-surface tests for `session/prompt`
- [ ] Add protocol-surface tests for `setSessionConfigOption`
- [ ] Add protocol-surface tests for `setSessionMode`
- [ ] Add protocol-surface tests for `unstable_setSessionModel`
- [ ] Add tests for `available_commands_update` emission
- [ ] Add tests for `config_option_update` emission

## Phase H: MCP server wiring

Main remaining MUST-level ACP compliance gap. Requires upstream pi SDK support
for per-session MCP server configuration.

- [ ] Wire `mcpServers` from `session/new` and `session/load` through to `createAgentSession()`
- [ ] Test with at least one MCP server (e.g. filesystem)
- [ ] Track upstream pi SDK issue/PR for `mcpServers` support in `createAgentSession()`

## Phase I: Optional ACP features

Lower priority. Implement when upstream pi support exists or clients need them.

- [ ] `session/request_permission` -- bridge to pi's extension permission system
- [ ] `agent_plan` updates -- requires pi to expose a planning surface
- [ ] ACP filesystem delegation (`readTextFile` / `writeTextFile`) -- allows
      reading unsaved editor buffers instead of on-disk files
- [ ] ACP terminal delegation (`terminal/create`, etc.) -- allows Zed to host
      terminal sessions

---

## Priority order

1. **Phase A** -- fix tool output rendering (unblocks basic usability)
2. **Phase B** -- terminal content lifecycle (proper Zed integration)
3. **Phase C** -- tool call metadata (UI polish)
4. **Phase D** -- streaming bash formatting (live output quality)
5. **Phase E** -- read tool escaping (correctness)
6. **Phase F** -- client capabilities (feature detection)
7. **Phase G** -- test coverage (quality)
8. **Phase H** -- MCP wiring (compliance)
9. **Phase I** -- optional features (completeness)
