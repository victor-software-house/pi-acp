# TODO

Gap inventory derived from `GAPS.md`, `docs/engineering/claude-acp-comparison.md`,
and direct analysis of `zed-industries/claude-agent-acp` and `zed-industries/codex-acp`.

Execution plan: `PLAN.md`.

Legend:

- [ ] not started
- [x] done

---

## Phase 1: Per-tool output formatting (critical)

Bash output is invisible/collapsed in Zed because pi-acp sends raw text
without formatting. Both reference implementations dispatch formatting by
tool name: `` ```console `` for bash, `markdownEscape()` for read, code
fences for errors.

- [ ] Create `src/acp/translate/tool-content.ts` with `formatToolContent(toolName, result, isError)`
- [ ] Bash results: extract stdout/stderr, wrap in `` ```console\n{output}\n``` ``
- [ ] Bash results: append `exit code: N` on non-zero exit
- [ ] Bash errors: wrap in `` ```\n{error}\n``` `` with `status: "failed"`
- [ ] Tmux results: same formatting as bash (`` ```console ``)
- [ ] Read results: apply `markdownEscape()` to text blocks
- [ ] Read results: preserve image content blocks unchanged
- [ ] LSP results: wrap in `` ```\n{text}\n``` ``
- [ ] Error results (all tools): wrap error text in code fences
- [ ] Edit/write: return empty array (diff path handles these)
- [ ] Fallback: plain text content for unknown tools
- [ ] Add `markdownEscape()` (port from claude-agent-acp `tools.ts`)
- [ ] Add focused extractors: `extractBashOutput()`, `extractTextContent()`, `extractContentBlocks()`
- [ ] Update `handleToolEnd()` in `session.ts` to use `formatToolContent`
- [ ] Update `handleToolUpdate()` to accept `toolName` parameter
- [ ] Update `handleToolUpdate()` to wrap bash/tmux output in `` ```console ``
- [ ] Update `replaySessionHistory()` in `agent.ts` to use `formatToolContent`
- [ ] Remove `toolResultToText()` from `pi-tools.ts`
- [ ] Add tests: bash output (normal, error, empty, non-zero exit)
- [ ] Add tests: read output (plain text, markdown-sensitive content, images)
- [ ] Add tests: error formatting across tool types
- [ ] Add tests: streaming bash formatting in `handleToolUpdate`
- [ ] Add tests: edit/write still get diff content (not affected by new formatter)
- [ ] Add tests: replay path produces formatted content

## Phase 2: Terminal content lifecycle

Both reference implementations emit a 3-phase terminal lifecycle when the
client supports it. codex-acp includes `cwd` in `terminal_info`. Both fall
back to code fences when terminal is not supported.

- [ ] Store `clientCapabilities` from `initialize` on `PiAcpAgent`
- [ ] Detect `clientCapabilities._meta.terminal_output === true`
- [ ] Add `supportsTerminalOutput` flag to `PiAcpSessionOpts`
- [ ] When terminal IS supported (bash/tmux):
  - [ ] `handleToolStart`: emit `content: [{ type: "terminal", terminalId }]` + `_meta.terminal_info { terminal_id, cwd }`
  - [ ] `handleToolUpdate`: emit `_meta.terminal_output { terminal_id, data }` (no content, meta only)
  - [ ] `handleToolEnd`: emit `_meta.terminal_exit { terminal_id, exit_code, signal: null }` alongside status
- [ ] When terminal NOT supported: use Phase 1 `` ```console `` fallback
- [ ] Add tests: terminal lifecycle sequence (info -> output -> exit)
- [ ] Add tests: cwd included in terminal_info
- [ ] Add tests: no content field when terminal_output meta is present
- [ ] Add tests: fallback to code fences without terminal support

## Phase 3: Tool call `_meta` and kind/title gaps

claude-agent-acp includes `_meta.claudeCode.toolName` on every tool emission.
GAPS.md identifies kind and title gaps for lsp, tmux, and context tools.

- [ ] Add `_meta: { piAcp: { toolName } }` to `tool_call` in `handleMessageUpdate`
- [ ] Add `_meta: { piAcp: { toolName } }` to `tool_call` in `handleToolStart`
- [ ] Add `_meta: { piAcp: { toolName } }` to `tool_call_update` in `handleToolUpdate`
- [ ] Add `_meta: { piAcp: { toolName } }` to `tool_call_update` in `handleToolEnd`
- [ ] Add `_meta: { piAcp: { toolName } }` to replayed tool calls in `replaySessionHistory`
- [ ] Merge `_meta` correctly when terminal meta is also present (no overwriting)
- [ ] Fix `toToolKind`: `lsp` -> `search`, `tmux` -> `execute`
- [ ] Fix `buildToolTitle` for `lsp`: `Definition src/index.ts:42`, `References MyClass`, etc.
- [ ] Fix `buildToolTitle` for `tmux`: `Tmux: <command>`, `Tmux <action> <name>`, etc.
- [ ] Fix `buildToolTitle` for `context_tag`: `Tag <name>`
- [ ] Fix `buildToolTitle` for `context_log`: `Context log`
- [ ] Fix `buildToolTitle` for `context_checkout`: `Checkout <target>`
- [ ] Fix `buildToolTitle` for `claudemon`: `Check quota`
- [ ] Add tests: `_meta.piAcp.toolName` present on all emissions
- [ ] Add tests: `_meta` merges correctly with terminal `_meta`
- [ ] Add tests: lsp kind/title for each action type
- [ ] Add tests: tmux kind/title for each action type
- [ ] Add tests: context tool titles

## Phase 4: Client capabilities

Both reference implementations store and use `clientCapabilities` for feature
detection and auth method selection.

- [ ] Create `ClientCapabilityFlags` interface (`terminalOutput`, `terminalAuth`, `gatewayAuth`)
- [ ] Create `parseClientCapabilities(caps)` function
- [ ] Store parsed capabilities on `PiAcpAgent` instance from `initialize`
- [ ] Pass relevant flags to `PiAcpSession` via opts
- [ ] Adapt auth methods in `initialize` response based on capabilities
- [ ] Support `_meta.terminal-auth` with command metadata (following claude-agent-acp pattern)
- [ ] Add tests: capability parsing from various client configs
- [ ] Add tests: terminal output flag propagated to sessions
- [ ] Add tests: auth methods vary based on capabilities
- [ ] Add tests: null/undefined/missing capabilities handled gracefully

## Phase 5: Streaming bash output formatting

codex-acp accumulates per-command output and sends the full buffer wrapped
in a code fence on each streaming update. pi already has rolling tail buffer
but sends raw text.

- [ ] Add `toolCallNames: Map<string, string>` to `PiAcpSession` (toolCallId -> toolName)
- [ ] Populate map in `handleToolStart`, clean up in `handleToolEnd`
- [ ] In `handleToolUpdate`, look up tool name from map
- [ ] Bash/tmux without terminal: wrap accumulated output in `` ```console ``
- [ ] Bash/tmux with terminal: emit `_meta.terminal_output` only (no content)
- [ ] Other tools: emit plain text content (no wrapping)
- [ ] Each update is self-contained (full buffer, not delta) -- matches pi's behavior
- [ ] Add tests: streaming bash with `` ```console `` wrapping
- [ ] Add tests: streaming bash with terminal_output metadata
- [ ] Add tests: streaming non-bash tools remain plain text
- [ ] Add tests: toolCallNames map lifecycle (populated, used, cleaned up)

## Phase 6: Protocol test coverage

- [ ] Extend `FakeAgentSession` to support `prompt()`, `setModel()`, `setThinkingLevel()`
- [ ] Add protocol-surface tests for `session/prompt`
- [ ] Add protocol-surface tests for `setSessionConfigOption`
- [ ] Add protocol-surface tests for `setSessionMode`
- [ ] Add protocol-surface tests for `unstable_setSessionModel`
- [ ] Add tests for `available_commands_update` emission
- [ ] Add tests for `config_option_update` emission

## Phase 7: MCP server wiring (blocked on pi SDK)

- [ ] Convert ACP `McpServer[]` to pi MCP config format (following claude-agent-acp pattern)
- [ ] Wire through to `createAgentSession()` when SDK supports it
- [ ] Test with stdio MCP server
- [ ] Test with HTTP/SSE MCP server
- [ ] Track upstream pi SDK issue/PR

## Phase 8: Optional ACP features (deferred)

- [ ] `session/request_permission` (follow claude-agent-acp `canUseTool()` pattern)
- [ ] `agent_plan` updates (follow codex-acp `update_plan()` pattern)
- [ ] `readTextFile` / `writeTextFile` delegation (follow claude-agent-acp delegate pattern)
- [ ] ACP terminal delegation
- [ ] Model alias resolution (port claude-agent-acp `resolveModelPreference()`)

---

## Priority order

1. **Phase 1** -- fix tool output rendering (unblocks basic usability)
2. **Phase 2** -- terminal content lifecycle (proper Zed integration)
3. **Phase 3** -- tool call metadata and kind/title gaps (UI polish)
4. **Phase 4** -- client capabilities detection (feature gating)
5. **Phase 5** -- streaming bash formatting (live output quality)
6. **Phase 6** -- test coverage (quality)
7. **Phase 7** -- MCP wiring (compliance, blocked)
8. **Phase 8** -- optional features (completeness, deferred)
