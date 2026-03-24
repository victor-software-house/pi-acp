# TODO

Gap inventory derived from `GAPS.md`, `docs/engineering/claude-acp-comparison.md`,
and direct analysis of `zed-industries/claude-agent-acp` and `zed-industries/codex-acp`.

Execution plan: `PLAN.md`.

Legend:

- [ ] not started
- [x] done

---

## Phase 1: Per-tool output formatting (v0.3.0) -- DONE

- [x] Create `src/acp/translate/tool-content.ts` with `formatToolContent(toolName, result, isError)`
- [x] Bash results: extract stdout/stderr, wrap in `` ```console\n{output}\n``` ``
- [x] Bash results: append `exit code: N` on non-zero exit
- [x] Bash errors: wrap in `` ```\n{error}\n``` `` with `status: "failed"`
- [x] Tmux results: same formatting as bash (`` ```console ``)
- [x] Read results: apply `markdownEscape()` to text blocks
- [x] Read results: preserve image content blocks unchanged
- [x] LSP results: wrap in `` ```\n{text}\n``` ``
- [x] Error results (all tools): wrap error text in code fences
- [x] Edit/write: return empty array (diff path handles these)
- [x] Fallback: plain text content for unknown tools
- [x] Add `markdownEscape()` (character-level escape)
- [x] Add focused extractors: `extractBashOutput()`, `extractTextContent()`, `extractContentBlocks()`
- [x] Update `handleToolEnd()` in `session.ts` to use `formatToolContent`
- [x] Update `handleToolUpdate()` to accept `toolName` parameter
- [x] Update `handleToolUpdate()` to wrap bash/tmux output in `` ```console ``
- [x] Update `replaySessionHistory()` in `agent.ts` to use `formatToolContent`
- [x] Remove `toolResultToText()` from `pi-tools.ts` (removed in Phase 6A along with its test file)
- [x] Add tests: bash output (normal, error, empty, non-zero exit)
- [x] Add tests: read output (plain text, markdown-sensitive content, images)
- [x] Add tests: error formatting across tool types
- [x] Add tests: streaming bash formatting in `handleToolUpdate`
- [x] Add tests: edit/write still get diff content (not affected by new formatter)
- [x] Add tests: replay path produces formatted content

## Phase 2: Terminal content lifecycle (v0.3.0) -- DONE

- [x] Store `clientCapabilities` from `initialize` on `PiAcpAgent`
- [x] Detect `clientCapabilities._meta.terminal_output === true`
- [x] Add `supportsTerminalOutput` flag to `PiAcpSessionOpts`
- [x] When terminal IS supported (bash/tmux):
  - [x] `handleToolStart`: emit `content: [{ type: "terminal", terminalId }]` + `_meta.terminal_info { terminal_id, cwd }`
  - [x] `handleToolUpdate`: emit `_meta.terminal_output { terminal_id, data }` (no content, meta only)
  - [x] `handleToolEnd`: emit `_meta.terminal_exit { terminal_id, exit_code, signal: null }` alongside status
- [x] When terminal NOT supported: use Phase 1 `` ```console `` fallback
- [x] Add tests: terminal lifecycle sequence (info -> output -> exit)
- [x] Add tests: cwd included in terminal_info
- [x] Add tests: no content field when terminal_output meta is present
- [x] Add tests: fallback to code fences without terminal support

## Phase 3: Tool call `_meta` and kind/title gaps (v0.3.0) -- DONE

- [x] Add `_meta: { piAcp: { toolName } }` to `tool_call` in `handleMessageUpdate`
- [x] Add `_meta: { piAcp: { toolName } }` to `tool_call` in `handleToolStart`
- [x] Add `_meta: { piAcp: { toolName } }` to `tool_call_update` in `handleToolUpdate`
- [x] Add `_meta: { piAcp: { toolName } }` to `tool_call_update` in `handleToolEnd`
- [x] Add `_meta: { piAcp: { toolName } }` to replayed tool calls in `replaySessionHistory`
- [x] Merge `_meta` correctly when terminal meta is also present (no overwriting)
- [x] Fix `toToolKind`: `lsp` -> `search`, `tmux` -> `execute`
- [x] Fix `buildToolTitle` for `lsp`: `Definition src/index.ts:42`, `References MyClass`, etc.
- [x] Fix `buildToolTitle` for `tmux`: `Tmux: <command>`, `Tmux <action> <name>`, etc.
- [x] Fix `buildToolTitle` for `context_tag`: `Tag <name>`
- [x] Fix `buildToolTitle` for `context_log`: `Context log`
- [x] Fix `buildToolTitle` for `context_checkout`: `Checkout <target>`
- [x] Fix `buildToolTitle` for `claudemon`: `Check quota`
- [x] Add tests: `_meta.piAcp.toolName` present on all emissions
- [x] Add tests: `_meta` merges correctly with terminal `_meta`
- [x] Add tests: lsp kind/title for each action type
- [x] Add tests: tmux kind/title for each action type
- [x] Add tests: context tool titles

## Phase 4: Client capabilities (v0.3.0) -- DONE

- [x] Create `ClientCapabilityFlags` interface (`terminalOutput`, `terminalAuth`, `gatewayAuth`)
- [x] Create `parseClientCapabilities(caps)` function
- [x] Store parsed capabilities on `PiAcpAgent` instance from `initialize`
- [x] Pass relevant flags to `PiAcpSession` via opts
- [x] Adapt auth methods in `initialize` response based on capabilities
- [x] Support `_meta.terminal-auth` with command metadata (following claude-agent-acp pattern)
- [x] Add tests: capability parsing from various client configs
- [x] Add tests: terminal output flag propagated to sessions
- [x] Add tests: auth methods vary based on capabilities
- [x] Add tests: null/undefined/missing capabilities handled gracefully

## Phase 5: Streaming bash output formatting (v0.3.0) -- DONE

- [x] Add `toolCallNames: Map<string, string>` to `PiAcpSession` (toolCallId -> toolName)
- [x] Populate map in `handleToolStart`, clean up in `handleToolEnd`
- [x] In `handleToolUpdate`, look up tool name from map
- [x] Bash/tmux without terminal: wrap accumulated output in `` ```console ``
- [x] Bash/tmux with terminal: emit `_meta.terminal_output` only (no content)
- [x] Other tools: emit plain text content (no wrapping)
- [x] Each update is self-contained (full buffer, not delta) -- matches pi's behavior
- [x] Add tests: streaming bash with `` ```console `` wrapping
- [x] Add tests: streaming bash with terminal_output metadata
- [x] Add tests: streaming non-bash tools remain plain text
- [x] Add tests: toolCallNames map lifecycle (populated, used, cleaned up)

## Phase 6: Protocol test coverage (v0.3.0) -- DONE

- [x] Extend `FakeAgentSession` to support `prompt()`, `setModel()`, `setThinkingLevel()`
- [x] Add protocol-surface tests for `setSessionConfigOption` (error path)
- [x] Add protocol-surface tests for `setSessionMode` (error path)
- [x] Add protocol-surface tests for `unstable_setSessionModel` (error path)
- [x] Add tests for auth methods varying based on client capabilities

## Phase 6A: Reference cleanup and ownership boundaries -- DONE

Derived from direct comparison with `zed-industries/claude-agent-acp` and
`zed-industries/codex-acp`, plus validation of pi's in-process `AgentSession`
API surface.

### 6A.1 Remove startup banner and runtime update-check code

- [x] Delete `cachedUpdateNotice`
- [x] Delete `buildUpdateNotice()`
- [x] Delete `isSemver()`
- [x] Delete `compareSemver()`
- [x] Delete `buildStartupInfo()`
- [x] Delete local `addSection()` helper inside startup-info generation
- [x] Remove startup-info emission from `newSession`
- [x] Remove startup-info `_meta` payloads from session responses
- [x] Remove startup-info emission from `loadSession`
- [x] Remove `quietStartup` gating from ACP session creation flow
- [x] Remove startup-info state/helpers from `PiAcpSession`
- [x] Remove startup-info-specific tests

### 6A.2 Keep builtin ACP command execution, but rewrite local command advertisement

- [x] Keep builtin handlers for `/compact`, `/autocompact`, `/export`, `/session`, `/name`, `/steering`, `/follow-up`, `/changelog`
- [x] Replace `builtinAvailableCommands()` with `const BUILTIN_COMMANDS`
- [x] Replace `mergeCommands()` with `deduplicateCommands()`
- [x] Continue sourcing prompts from `piSession.promptTemplates`
- [x] Continue sourcing skills from `piSession.resourceLoader.getSkills()`
- [x] Continue sourcing extension commands from `piSession.extensionRunner.getRegisteredCommands()`

### 6A.3 Keep `/changelog`, remove unrelated helper clutter

- [x] Keep `findChangelog()` for `/changelog`
- [x] Replace `readNearestPackageJson()` with package JSON import (`pkgJson`)
- [x] Remove dead `toolResultToText()` from `pi-tools.ts` (and its test file)
- [x] Remove dead imports and comments left behind by the cleanup

## Phase 7: Correctness and UX improvements -- DONE

Derived from comparison with `zed-industries/claude-agent-acp`.

### 7.1 Fix `markdownEscape` to use dynamic backtick fence wrapping

- [x] Replace `markdownEscape()` in `tool-content.ts` with fence-wrapping approach
- [x] Find longest backtick sequence in text, use fence one longer
- [x] Handle trailing newline (no double newline before closing fence)
- [x] Update tests for new escape behavior (unit and component)

### 7.2 Model alias resolution

- [x] Add `resolveModelPreference(models, preference)` in `model-alias.ts`
- [x] Tokenize preference string: split on non-alphanumeric, lowercase, strip "claude"
- [x] Support exact match on `provider/id` and `id` alone
- [x] Scored token match with non-numeric match requirement
- [x] Support context hint syntax (e.g. `sonnet[3.5]`)
- [x] Use in `setSessionConfigOption` and `unstable_setSessionModel`
- [x] Add tests: exact match, alias match ("opus"), context hint, no match, case-insensitive

### 7.3 Separate `terminal_output` from `terminal_exit` notification

- [x] In `handleToolEnd`, when terminal supported: emit `terminal_output` update first
- [x] Then emit `terminal_exit` + status in a second update
- [x] Update tests to verify two separate emissions and ordering

### 7.4 Prompt queueing

- [x] Add `promptRunning` flag to `PiAcpSession`
- [x] Add `pendingMessages` queue (array of pending prompts)
- [x] When prompt arrives during active turn: queue it, return promise
- [x] On turn completion: dequeue and execute next prompt via `dequeueNextPrompt()`
- [x] On cancel: resolve all pending with `cancelled`
- [x] Add tests: queued prompt executes after first completes
- [x] Add tests: cancel resolves all pending

### 7.5 Exhaustive event handling

- [x] Add `unreachable(value, context?)` utility in `unreachable.ts`
- [x] Replace `default: break` in `handlePiEvent` with `unreachable` + log

## Phase 8: MCP server wiring (blocked on pi SDK)

- [ ] Convert ACP `McpServer[]` to pi MCP config format (following claude-agent-acp pattern)
- [ ] Wire through to `createAgentSession()` when SDK supports it
- [ ] Test with stdio MCP server
- [ ] Test with HTTP/SSE MCP server
- [ ] Track upstream pi SDK issue/PR

## Phase 9: Optional ACP features (blocked on pi SDK)

- [ ] `session/request_permission` (follow claude-agent-acp `canUseTool()` pattern)
- [ ] `agent_plan` updates (follow codex-acp `update_plan()` pattern)
- [ ] `readTextFile` / `writeTextFile` delegation (follow claude-agent-acp delegate pattern)
- [ ] ACP terminal delegation

---

## Priority order

1. ~~**Phase 1** -- fix tool output rendering (unblocks basic usability)~~ DONE v0.3.0
2. ~~**Phase 2** -- terminal content lifecycle (proper Zed integration)~~ DONE v0.3.0
3. ~~**Phase 3** -- tool call metadata and kind/title gaps (UI polish)~~ DONE v0.3.0
4. ~~**Phase 4** -- client capabilities detection (feature gating)~~ DONE v0.3.0
5. ~~**Phase 5** -- streaming bash formatting (live output quality)~~ DONE v0.3.0
6. ~~**Phase 6** -- test coverage (quality)~~ DONE v0.3.0
7. ~~**Phase 6A** -- reference cleanup and ownership boundaries~~ DONE
8. ~~**Phase 7** -- correctness and UX improvements (reference implementation parity)~~ DONE
9. **Phase 8** -- MCP wiring (compliance, blocked on pi SDK)
10. **Phase 9** -- optional features (completeness, blocked on pi SDK)
