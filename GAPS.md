# ACP Conformance Gaps

Comparison of pi-acp against the Zed reference implementations
(`zed-industries/claude-agent-acp` and `zed-industries/codex-acp`).

Last reviewed: 2026-03-23

## Tool kind mapping

ACP SDK `ToolKind` values: `execute`, `edit`, `read`, `search`, `think`,
`fetch`, `switch_mode`, `other`.

| pi tool | pi-acp kind | Reference equivalent | Status |
|---|---|---|---|
| `read` | `read` | `read` | Conformant |
| `write` | `edit` | `edit` | Conformant |
| `edit` | `edit` | `edit` | Conformant |
| `bash` | `execute` | `execute` | Conformant |
| `lsp` | `other` (fallback) | `search` (Glob/Grep/Search pattern) | Gap |
| `tmux` | `other` (fallback) | `execute` (shell command pattern) | Gap |
| `context_tag` | `other` | N/A | Conformant (`other` is reasonable) |
| `context_log` | `other` | N/A | Conformant |
| `context_checkout` | `other` | N/A | Conformant |
| `claudemon` | `other` | N/A | Conformant |

## Tool title mapping

| pi tool | pi-acp title | Reference pattern | Status |
|---|---|---|---|
| `read` | `Read <path>` | `Read <file_path>` | Conformant |
| `write` | `Write <path>` | `Write <file_path>` | Conformant |
| `edit` | `Edit <path>` | `Edit <file_path>` | Conformant |
| `bash` | `Run <command>` | `<command>` or `Terminal` | Conformant |
| `lsp` | `lsp` (raw name) | Descriptive (e.g. `Find <pattern>`) | Gap |
| `tmux` | `tmux` (raw name) | Descriptive (e.g. `Run <cmd>`) | Gap |
| `context_tag` | `context_tag` (raw name) | N/A | Minor gap |
| `context_log` | `context_log` (raw name) | N/A | Minor gap |
| `context_checkout` | `context_checkout` (raw name) | N/A | Minor gap |
| `claudemon` | `claudemon` (raw name) | N/A | Minor gap |

## Tool content and terminal output

| Feature | claude-agent-acp | codex-acp | pi-acp | Status |
|---|---|---|---|---|
| Edit/Write diffs | `Diff` with `oldText`/`newText` on tool call | `Diff` from patch changes | Diff on `tool_call_update` (end) | Conformant |
| Bash terminal output | `_meta.terminal_info`/`terminal_output`/`terminal_exit` | Same pattern | Not implemented | Deferred (Phase 4) |
| Tool locations | `path` + `line` | `path` | `path` + `line` (edit oldText) | Conformant |

## Agent interface methods

| Method | claude-agent-acp | codex-acp | pi-acp | Status |
|---|---|---|---|---|
| `initialize` | Yes | Yes | Yes | Conformant |
| `authenticate` | Yes | Yes | Yes | Conformant |
| `newSession` | Yes | Yes | Yes | Conformant |
| `loadSession` | Yes | Yes | Yes | Conformant |
| `listSessions` | Yes | Yes | Yes | Conformant |
| `prompt` | Yes | Yes | Yes | Conformant |
| `cancel` | Yes | Yes | Yes | Conformant |
| `setSessionMode` | Yes | Yes | Yes | Conformant |
| `setSessionConfigOption` | Yes | N/A | Yes | Conformant |
| `unstable_setSessionModel` | Yes | Yes | Yes | Conformant |
| `unstable_closeSession` | N/A | N/A | Yes | Extra |
| `unstable_resumeSession` | N/A | N/A | Yes | Extra |
| `unstable_forkSession` | Yes | N/A | Yes | Conformant |
| `readTextFile` | Yes (delegates to client) | No | No | Gap |
| `writeTextFile` | Yes (delegates to client) | No | No | Gap |

## Session updates (agent to client)

| Update | claude-agent-acp | codex-acp | pi-acp | Status |
|---|---|---|---|---|
| `agent_message_chunk` | Yes | Yes | Yes | Conformant |
| `agent_thought_chunk` | Yes | Yes | Yes | Conformant |
| `tool_call` | Yes | Yes | Yes | Conformant |
| `tool_call_update` | Yes | Yes | Yes | Conformant |
| `user_message_chunk` | Yes (replay) | Yes (replay) | Yes (replay) | Conformant |
| `usage_update` | Yes | Yes | Yes | Conformant |
| `available_commands_update` | N/A | N/A | Yes | Extra |
| `config_option_update` | Yes | Yes | Yes | Conformant |
| `current_mode_update` | Yes | Yes | Yes | Conformant |
| `session_info_update` | N/A | N/A | Yes (via `/name`) | Extra |

---

## Actionable gaps

### 1. `lsp` tool kind should be `search`

**Severity:** Low

The `lsp` tool performs definition lookups, reference searches, symbol queries,
and diagnostics. The reference implementations map analogous tools (`Glob`,
`Grep`, `ListFiles`, `Search`) to `search`.

**Fix:** Add `case "lsp": return "search"` to `toToolKind` in `session.ts`.

### 2. `tmux` tool kind should be `execute`

**Severity:** Low

The `tmux` tool runs and manages background commands and terminals. The
reference implementations map shell command execution to `execute`.

**Fix:** Add `case "tmux": return "execute"` to `toToolKind` in `session.ts`.

### 3. `lsp` tool title is the raw name

**Severity:** Low

The reference implementations build descriptive titles from tool arguments.
`lsp` should produce titles like `Definition src/index.ts:42`,
`References MyClass`, or `Symbols src/main.ts`.

**Fix:** Add a case to `buildToolTitle` that reads `action`, `file`, `query`,
and `line` from args.

### 4. `tmux` tool title is the raw name

**Severity:** Low

`tmux` should produce titles like `Run (tmux) dev-server`,
`Peek tmux`, or `Kill tmux session`.

**Fix:** Add a case to `buildToolTitle` that reads `action`, `command`, and
`name` from args.

### 5. `context_tag`, `context_log`, `context_checkout`, `claudemon` titles are raw names

**Severity:** Low

These tools could produce more descriptive titles from their arguments:

- `context_tag`: `Tag <name>`
- `context_log`: `Context log`
- `context_checkout`: `Checkout <target>`
- `claudemon`: `Check quota`

**Fix:** Add cases to `buildToolTitle` for each.

---

## Deferred gaps

### 6. Terminal `_meta` for bash tool calls

**Status:** Phase 4 in TODO.md -- deferred

Both reference implementations emit structured terminal metadata when the client
supports it:

- `_meta.terminal_info` on tool call start (`terminal_id`, `cwd`)
- `_meta.terminal_output` on output deltas (`terminal_id`, `data`)
- `_meta.terminal_exit` on completion (`terminal_id`, `exit_code`, `signal`)

pi-acp falls back to plain text content for all bash output. No ACP client
currently consumes these extensions, so this is deferred until a client signals
support or the ACP spec standardizes terminal content.

### 7. `readTextFile` / `writeTextFile` delegation

**Status:** Intentionally excluded

claude-agent-acp implements these to delegate file operations to the ACP client,
enabling virtual filesystems or sandboxed access. pi operates on disk directly
and does not expose hooks for client-delegated file I/O. Implementing this would
require pi SDK changes.

### 8. MCP server wiring per session

**Status:** P2 in ROADMAP.md -- blocked on pi SDK

`createAgentSession()` does not accept per-session `mcpServers`. The
`mcpServers` parameter from `session/new` and `session/load` is stored but not
wired through.

### 9. `session/request_permission`

**Status:** P3 in ROADMAP.md -- blocked on pi SDK

The ACP permission gate for tool execution. pi owns tool execution and approval
internally with no hook for external permission gates.

### 10. `agent_plan` updates

**Status:** P3 in ROADMAP.md

claude-agent-acp maps `TodoWrite` to a `think` tool kind. pi has no equivalent
planning surface or todo-write API.
